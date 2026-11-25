#!/usr/bin/env python3
"""真实 Workbench HTTP → stdio MCP → 外置 flowd 验收。构建后从仓库根目录运行：

    (cd flow-host && npm run build)
    cargo build --locked --manifest-path flow-host/client/Cargo.toml
    cargo build --locked --manifest-path workbench/Cargo.toml -p ursi-server
    python3 workbench/server/tests/executor_mcp_e2e.py
"""
import argparse
from contextlib import contextmanager
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[3]
FLOW_ID = 'executor-e2e'
FLOW = '''---
name: 命令验收
description: 记录执行次数并生成报告
variables:
  任务:
    description: 冻结指令
---
```mermaid
flowchart TD
  start((开始)) --> work[工作]
  work -->|已执行| finish((结束))
```
## 工作
```执行自定义命令
{"command":"node","args":["scripts/task.mjs"],"stdin":"{var.任务}"}
```
### 已执行
写入报告。
'''
SCRIPT = r'''import fs from 'node:fs';
const note = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(EFFECTS, JSON.stringify(note) + '\n');
fs.writeFileSync('artifacts/report.txt', note);
if (fs.existsSync('inputs/material.txt')) fs.copyFileSync('inputs/material.txt', 'artifacts/material.txt');
if (note === '等待取消') setTimeout(() => {}, 120000);
'''


def command(path):
    path = path.resolve(strict=True)
    return [shutil.which('node'), str(path)] if path.suffix in ('.js', '.mjs') else [str(path)]


def wait(check, description, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.05)
    raise AssertionError(f'timed out: {description}')


# Fault injector: stdin goes unchanged to the real adapter. Forward initialization
# and notifications, then discard exactly one observed successful start reply.
# On subsequent launches the shell wrapper execs the adapter without a proxy.
def lose_reply(marker, argv):
    with subprocess.Popen(argv, stdout=subprocess.PIPE) as child:
        try:
            for frame in child.stdout:
                result = json.loads(frame).get('result', {}).get('structuredContent', {})
                if result.get('attemptId') == marker.read_text() and result.get('status'):
                    marker.rename(marker.with_suffix('.dropped'))
                    return
                sys.stdout.buffer.write(frame)
                sys.stdout.buffer.flush()
        finally:
            if child.poll() is None:
                child.kill()


class ExecutorAcceptance(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='ursi-mcp-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.home = self.root / 'flow'
        self.effects = self.root / 'effects.jsonl'
        self.effects.touch()
        self.sessions = self.root / 'sessions'
        self.sessions.touch()
        self.marker = self.root / 'lose'
        self.token = secrets.token_hex(32)
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.root), 'LANG': 'C.UTF-8',
                    'URSI_FLOW_HOME': str(self.home)}
        self.daemon = self.enter_process(command(BINS.daemon), self.env, 'flowd')
        wait(lambda: self.alive(self.daemon) and (self.home / 'runtime.sock').is_socket(),
             'external flowd socket')
        pkg = self.root / 'package'
        (pkg / 'scripts').mkdir(parents=True)
        (pkg / 'FLOW.md').write_text(FLOW, encoding='utf-8')
        (pkg / 'scripts/task.mjs').write_text(SCRIPT.replace('EFFECTS', json.dumps(str(self.effects))),
                                               encoding='utf-8')
        # flowd validates provider configuration even for command-only Flows.
        self.cli('config', 'set', json.dumps({'provider': {'apiKey': 'fixture', 'model': 'unused',
                                                          'baseUrl': 'http://127.0.0.1:1'}}))
        self.revision = self.cli('flow', 'create', FLOW_ID, str(pkg))['revision']
        adapter = command(BINS.adapter_bin)
        inject = [sys.executable, str(Path(__file__).resolve()), '--drop', str(self.marker), *adapter]
        self.wrapper = self.root / 'adapter'
        self.wrapper.write_text('#!/bin/sh\nset -eu\n'
                                f'echo $$ >> {shlex.quote(str(self.sessions))}\n'
                                f'if [ -f {shlex.quote(str(self.marker))} ]; then exec {shlex.join(inject)}; fi\n'
                                f'exec {shlex.join(adapter)}\n', encoding='utf-8')
        self.wrapper.chmod(0o700)

    @contextmanager
    def process(self, argv, env, name):
        log = self.root / (name + '.log')
        with log.open('ab') as out:
            proc = subprocess.Popen(argv, cwd=self.root, env=env, stdout=out, stderr=out)
        try:
            yield proc, log
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                    self.fail(f'{name} shutdown timeout')

    def enter_process(self, *args):
        cm = self.process(*args)
        child = cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)
        return child

    def alive(self, child):
        proc, log = child
        if proc.poll() is not None:
            self.fail(f'{proc.args[0]} exited {proc.returncode}: {log.read_text()[-2000:]}')
        return True

    def cli(self, *args):
        result = subprocess.run([BINS.cli, *args], cwd=self.root, env=self.env, timeout=10,
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    @contextmanager
    def server(self, enabled=True):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        env = dict(self.env, URSI_API_TOKEN=self.token, URSI_LISTEN_ADDR=f'127.0.0.1:{self.port}',
                   URSI_DATA_DIR=str(self.root / 'data'), URSI_FLOW_ENABLED='0',
                   URSI_EXECUTOR_FLOW=FLOW_ID, URSI_EXECUTOR_FLOW_REVISION=self.revision)
        if enabled:
            env['URSI_EXECUTOR_BIN'] = str(self.wrapper)
        with self.process([BINS.server], env, 'workbench') as server:
            def ready():
                self.alive(server)
                try:
                    self.http('GET', '/work-items')
                    return True
                except ConnectionRefusedError:
                    return False
            wait(ready, 'authenticated Workbench HTTP')
            yield
        self.alive(self.daemon)

    def send(self, conn, method, path, body, auth=True):
        headers = {'Content-Type': 'application/octet-stream' if isinstance(body, bytes) else 'application/json'}
        if auth:
            headers['Authorization'] = 'Bearer ' + self.token
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        conn.request(method, '/api/v2' + path, body, headers)

    def http(self, method, path, body=None, *, expect=range(200, 300), auth=True, raw=False):
        conn = HTTPConnection('127.0.0.1', self.port, timeout=20)
        try:
            self.send(conn, method, path, body, auth)
            response = conn.getresponse()
            data = response.read()
            self.assertIn(response.status, expect, f'{method} {path}: {response.status} {data!r}')
            return data if raw or not data else json.loads(data)
        finally:
            conn.close()

    def body(self, text, patch=None):
        result = {'workInstruction': {'text': text, 'encoding': 'utf-8'}}
        if patch:
            result['workPatchId'] = patch
        return result

    def attempt(self):
        key = str(uuid.uuid4())
        return key, '/executor-attempts/' + key

    def check_attempt(self, attempt, key):
        self.assertEqual(attempt['attemptId'], key)
        self.assertEqual(attempt['artifactDirectoryRef'], 'artifacts:' + key)

    def terminal(self, key, path, status):
        def poll():
            attempt = self.http('GET', path)
            self.check_attempt(attempt, key)
            if attempt['status'] in ('starting', 'running'):
                return None
            self.assertEqual(attempt['status'], status, attempt)
            return attempt
        return wait(poll, f'{key} -> {status}')

    def effects_list(self):
        return [json.loads(line) for line in self.effects.read_text().splitlines()]

    def test_start_retry_and_freeze(self):
        with self.server():
            patch = self.http('POST', '/patches/work', {'name': '验收输入'})
            source = '/directories/' + patch['directoryId'] + '/file?path=material.txt'
            self.http('PUT', source, b'first version')
            key, path = self.attempt()
            note = '检查材料\n并输出报告'
            body = self.body(note, patch['id'])
            self.check_attempt(self.http('PUT', path, body), key)
            self.http('PUT', source + '&replace=true', b'new version')
            self.check_attempt(self.http('PUT', path, dict(body, runConfig={})), key)
            self.http('PUT', path, dict(body, runConfig={'other': True}), expect=(409,))
            self.http('PUT', path, self.body('改动指令', patch['id']), expect=(409,))
            self.http('PUT', path, self.body(note), expect=(409,))
            done = self.terminal(key, path, 'succeeded')
            history = self.cli('run', 'history', key)
            job = history['job']
            self.assertEqual((job['id'], job['flow'], job['revision'], job['status']),
                             (key, FLOW_ID, self.revision, 'completed'))
            self.assertEqual(len(history['nodeRuns']), 1)
            self.assertEqual(self.effects_list(), [note])
            directory = '/directories/' + done['artifactDirectoryId']
            self.assertEqual(self.http('GET', directory + '/file?path=material.txt', raw=True), b'first version')
            report = directory + '/file?path=report.txt'
            self.assertEqual(self.http('GET', report, raw=True), note.encode())
            self.http('PUT', report + '&replace=true', b'changed', expect=(409,))
            self.http('PUT', directory + '/file?path=new.txt', b'late', expect=(409,))
            self.assertEqual(self.http('GET', report, raw=True), note.encode())

    def test_rejects_unsupported_run_config_before_daemon_start(self):
        with self.server():
            _, path = self.attempt()
            self.http('PUT', path, dict(self.body('检查配置'), runConfig={'flow': 'override'}), expect=(400,))
            self.assertEqual(self.cli('run', 'list'), [])

    def test_lost_start_receipt(self):
        key, path = self.attempt()
        note = '仅执行一次'
        with self.server():
            self.marker.write_text(key)
            conn = HTTPConnection('127.0.0.1', self.port, timeout=20)
            try:
                self.send(conn, 'PUT', path, self.body(note))
                wait(self.marker.with_suffix('.dropped').exists, 'real MCP start reply to be dropped')
            finally:
                conn.close()  # No HTTP response or backend run ID is consumed either.
        sessions = self.sessions.read_text().splitlines()
        with self.server():
            done = self.terminal(key, path, 'succeeded')  # GET only: no second PUT
            self.assertTrue(set(self.sessions.read_text().splitlines()) - set(sessions),
                            'recovery did not open a fresh stdio MCP session')
            self.assertEqual(self.effects_list(), [note])
            self.assertEqual([run['id'] for run in self.cli('run', 'list')], [key])
            report = f'/directories/{done["artifactDirectoryId"]}/file?path=report.txt'
            self.assertEqual(self.http('GET', report, raw=True), note.encode())

    def test_stale_revision(self):
        key, path = self.attempt()
        with self.server():
            self.cli('flow', 'create', 'other-flow', str(self.root / 'package'))
            self.http('PUT', path, self.body('过期的启动'), expect=(409,))
            self.assertFalse(any(r['id'] == key for r in self.cli('run', 'list')))
            self.assertEqual(self.effects_list(), [])

    def test_cancel(self):
        key, path = self.attempt()
        note = '等待取消'
        with self.server():
            self.check_attempt(self.http('PUT', path, self.body(note)), key)
            wait(lambda: note in self.effects_list(), 'cancel target to execute its command')
            self.assertEqual(self.cli('run', 'get', key)['status'], 'running')
            self.http('POST', path + '/cancel', auth=False, expect=(401,))
            self.check_attempt(self.http('POST', path + '/cancel'), key)
            self.terminal(key, path, 'cancelled')
            self.assertEqual(self.cli('run', 'get', key)['status'], 'stopped')
            self.assertEqual(self.effects_list(), [note])

    def test_disabled(self):
        _, path = self.attempt()
        with self.server(enabled=False):
            for method, url, body in [('PUT', path, self.body('禁止运行')), ('GET', path, None),
                                      ('POST', path + '/cancel', None)]:
                self.http(method, url, body, auth=False, expect=(401,))
            self.http('PUT', path, self.body('禁止运行'), expect=(503,))
            self.assertEqual(self.cli('run', 'list'), [])
            self.assertEqual(self.effects_list(), [])


if __name__ == '__main__':
    if sys.argv[1:2] == ['--drop']:
        lose_reply(Path(sys.argv[2]), sys.argv[3:])
        sys.exit(0)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name, default in [('server', 'workbench/target/debug/ursi-server'),
                          ('cli', 'flow-runtime/client/target/debug/ursi-flow'),
                          ('daemon', 'flow-host/dist/machine/daemon.js'),
                          ('adapter-bin', 'flow-host/dist/integrations/mcp/stdio.js')]:
        parser.add_argument('--' + name, type=Path, default=ROOT / default)
    BINS = parser.parse_args()
    BINS.server = BINS.server.resolve(strict=True)
    BINS.cli = BINS.cli.resolve(strict=True)
    unittest.main(argv=[__file__], verbosity=2)
