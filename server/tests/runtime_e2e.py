"""Black-box acceptance: scripts/ci/run-workspace-isolation.sh server (Linux)."""
import argparse
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import secrets
import shlex
import signal
import socket
import subprocess
import tempfile
import time
import unittest


FLOW = '''---
name: 验收
description: 在可信工作区执行真实命令
variables:
  note:
    description: 命令输入
    default: smoke
---
```mermaid
flowchart TD
  start((开始)) --> work[工作]
  work -->|已执行| finish((结束))
```
## 工作
```执行自定义命令
{"command":"node","args":["scripts/task.mjs"],"stdin":"{var.note}"}
```
### 已执行
完成工作。
'''
SCRIPT = '''import fs from 'node:fs';
const note = JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify([process.cwd(), note]));
'''
LONG_SCRIPT = '''import fs from 'node:fs';
fs.writeFileSync('command.pid', String(process.pid));
setTimeout(() => {}, 60000);
'''
FILES = {'FLOW.md': FLOW, 'scripts/task.mjs': SCRIPT}
OK = range(200, 300)
BAD_REQUEST = (400, 422)


def eventually(check, description):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.05)
    raise AssertionError(f'timed out: {description}')


def exited(pid):
    try:
        state = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
    except FileNotFoundError:
        return True
    return state in ('Z', 'X')


class RuntimeAcceptance(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='ursi-e2e-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.workspace = self.root / 'workspace'
        self.home = self.root / 'data/flow-runtime'
        self.workspace.mkdir()
        self.pidfile = self.root / 'flowd.pid'
        wrapper = self.root / 'flowd'
        wrapper.write_text('#!/bin/sh\n' + f'echo $$ > {shlex.quote(str(self.pidfile))}\n'
                           + f'exec node {shlex.quote(str(BINS.daemon))} "$@"\n')
        wrapper.chmod(0o700)
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            self.port = s.getsockname()[1]
        self.token = secrets.token_hex(32)
        self.env = dict(PATH=os.environ['PATH'], HOME=str(self.root),
                        URSI_LISTEN_ADDR=f'127.0.0.1:{self.port}', URSI_API_TOKEN=self.token,
                        URSI_WORKSPACE_DIR=str(self.workspace),
                        URSI_DATA_DIR=str(self.home.parent), URSI_FLOWD_BIN=str(wrapper))
        self.log = self.root / 'server.log'
        self.server = None
        self.addCleanup(self.stop_server)
        self.start_server()

    def start_server(self):
        with self.log.open('ab') as f:
            self.server = subprocess.Popen([BINS.server], env=self.env, cwd=self.root,
                                           stdout=f, stderr=f)

        def ready():
            self.assertIsNone(self.server.poll(), self.log.read_text())
            try:
                return self.request('GET', '/api/v1/flows')[0] in OK
            except OSError:
                return False
        eventually(ready, 'authenticated HTTP readiness')
        self.assertTrue((self.home / 'runtime.sock').is_socket())
        self.assertFalse(exited(int(self.pidfile.read_text())), 'server did not launch flowd')
        self.assertEqual(self.home.stat().st_mode & 0o077, 0, 'shared runtime home')

    def stop_server(self):
        process, self.server = self.server, None
        if process is None:
            return
        try:
            self.assertIsNone(process.poll(), self.log.read_text())
            process.send_signal(signal.SIGINT)
            self.assertEqual(process.wait(timeout=15), 0, self.log.read_text())
            if self.pidfile.exists():
                pid = int(self.pidfile.read_text())
                eventually(lambda: exited(pid), 'owned daemon to exit')
            self.assertFalse((self.home / 'runtime.sock').exists(), 'stale runtime socket')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            if self.pidfile.exists():
                pid = int(self.pidfile.read_text())
                if not exited(pid):
                    os.kill(pid, signal.SIGTERM)

    def request(self, method, path, body=None, auth=True):
        conn = HTTPConnection('127.0.0.1', self.port, timeout=5)
        headers = {'Content-Type': 'application/json'}
        if auth:
            headers['Authorization'] = 'Bearer ' + (self.token if auth is True else auth)
        try:
            conn.request(method, path,
                         None if body is None else json.dumps(body), headers)
            r = conn.getresponse()
            return r.status, r.read()
        finally:
            conn.close()

    def http(self, method, path, body=None, *, expect=OK, auth=True):
        status, raw = self.request(method, '/api/v1' + path, body, auth)
        self.assertIn(status, expect, f'{method} {path}: {status} {raw!r}')
        if status in OK:
            return json.loads(raw)
        self.assertNotIn(self.token.encode(), raw)
        self.assertNotIn(os.fsencode(self.root), raw)

    def cli(self, *args):
        p = subprocess.run([BINS.cli, *args], cwd=self.workspace, timeout=10,
                           env={'PATH': self.env['PATH'], 'URSI_FLOW_HOME': str(self.home)},
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_http_boundary_and_config(self):
        for path in ('/', '/runs/example', '/app.js'):
            self.assertEqual(self.request('GET', path, auth=False)[0], 404)
        config = self.cli('config', 'get')
        for auth in (False, 'wrong-token'):
            self.http('GET', '/flows', auth=auth, expect=(401,))
            self.http('PATCH', '/flow-config', {'maxConcurrent': 2}, auth=auth, expect=(401,))
        self.assertEqual(self.cli('config', 'get'), config)
        self.assertEqual(self.http('GET', '/flow-config'), config)
        from_cli = self.cli('config', 'set', '{"maxConcurrent":3}')
        self.assertEqual(self.http('GET', '/flow-config'), from_cli)
        changed = self.http('PATCH', '/flow-config', {'maxConcurrent': 2})
        self.assertEqual(changed['maxConcurrent'], 2)
        self.assertEqual(changed, self.cli('config', 'get'))
        self.http('PATCH', '/flow-config', {'maxConcurrent': 0}, expect=BAD_REQUEST)
        self.assertEqual(self.cli('config', 'get'), changed)
        for path in ('/workflows', '/roles', '/artifacts', '/sandboxes', '/connections', '/runs/sample/events'):
            self.http('GET', path, expect=(404,))
        self.http('POST', '/mcp/invoke', {}, expect=(404,))
        self.http('POST', '/runs', {}, expect=(405,))

    def test_package_revision_and_history(self):
        pkg = {'id': 'work', 'files': FILES}
        self.assertEqual(self.http('POST', '/flows/validate', pkg), {'id': 'work', 'valid': True})
        self.assertEqual(self.cli('flow', 'list'), [])
        first = self.http('POST', '/flows', pkg)['revision']
        self.assertEqual(self.http('GET', '/flows'), ['work'])
        saved = {**pkg, 'revision': first}
        self.assertEqual(self.cli('flow', 'get', 'work'), saved)
        for invalid in ({'FLOW.md': 'invalid'}, {**FILES, 'other.txt': 'not a package file'}):
            self.http('PUT', '/flows/work', {'files': invalid}, expect=BAD_REQUEST)
            self.assertEqual(self.http('GET', '/flows/work'), saved)
        updated = {**FILES, 'references/note.md': 'new revision'}
        second = self.http('PUT', '/flows/work', {'files': updated, 'expectedRevision': first})['revision']
        self.assertNotEqual(first, second)
        self.http('PUT', '/flows/work', {'files': FILES, 'expectedRevision': first}, expect=(409,))
        self.assertEqual(self.cli('flow', 'get', 'work')['files'], updated)

        body = {'workspace': 'default', 'variables': {'note': secrets.token_hex(8)}}
        self.http('POST', '/flows/work/runs', {**body, 'workspace': str(self.root)}, expect=BAD_REQUEST)
        self.http('POST', '/flows/work/runs', {**body, 'cwd': str(self.root)}, expect=BAD_REQUEST)
        self.assertEqual(self.cli('run', 'list'), [])
        job = self.http('POST', '/flows/work/runs', body)
        key = job['id']
        self.assertEqual(job['revision'], second)
        self.assertEqual(job['cwd'], str(self.workspace))
        eventually(lambda: self.cli('run', 'get', key)['status'] != 'running', 'command to finish')
        ended = self.http('GET', f'/runs/{key}')
        self.assertEqual(ended['status'], 'completed', ended)
        self.assertEqual(self.http('GET', '/runs'), [ended])
        self.assertEqual(self.http('DELETE', '/flows/work')['id'], 'work')
        self.assertEqual(self.cli('flow', 'list'), [])
        self.http('GET', '/flows/work', expect=(404,))
        history = self.http('GET', f'/runs/{key}/history')
        self.assertEqual(history, self.cli('run', 'history', key))
        self.assertEqual(history['job'], ended)
        node, = history['nodeRuns']
        self.assertEqual(node['nodeRef'], 'work')
        self.assertEqual(node['outcome']['result'], '已执行')
        self.assertEqual(node['commandResult']['exitCode'], 0)
        self.assertEqual(json.loads(node['commandResult']['stdout']), [str(self.workspace), body['variables']['note']])
        self.stop_server()
        self.start_server()
        self.assertEqual(self.http('GET', f'/runs/{key}/history'), history)

    def test_stop_and_shutdown_reap_commands(self):
        self.http('POST', '/flows', {'id': 'hold', 'files': {**FILES, 'scripts/task.mjs': LONG_SCRIPT}})
        marker = self.workspace / 'command.pid'
        for key in ('explicit-stop', 'shutdown'):
            body = {'runId': key, 'workspace': 'default', 'variables': {}}
            self.assertEqual(self.http('POST', '/flows/hold/runs', body)['id'], key)
            eventually(lambda: marker.exists() and marker.read_text().isdigit(), 'command PID in workspace')
            pid = int(marker.read_text())
            self.assertFalse(exited(pid))
            if key == 'explicit-stop':
                self.assertEqual(self.http('POST', f'/runs/{key}/stop')['status'], 'stopped')
                self.assertEqual(self.cli('run', 'get', key)['status'], 'stopped')
                marker.unlink()
            else:
                self.stop_server()
            eventually(lambda: exited(pid), f'{key}: command to exit')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('server', 'cli', 'daemon'):
        parser.add_argument('--' + name, required=True, type=lambda p: Path(p).resolve(strict=True))
    BINS = parser.parse_args()
    unittest.main(argv=[__file__], verbosity=2)
