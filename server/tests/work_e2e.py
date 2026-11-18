#!/usr/bin/env python3
"""Black-box work acceptance. See WORK-ACCEPTANCE.md for build and rerun commands."""
import argparse
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
MODEL = 'fixed-local-model'
ANSWER = 'SIMULATED-MODEL: fixed report'
SOP = 'SOP-read-the-ticket'
GUIDE = 'PROMPT-check-the-evidence-v1'
FLOW = '''---
name: 验收
description: 记录节点副作用
variables:
  note:
    description: 工作项输入
    default: missing
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
fs.appendFileSync('effects', note + '\\n');
console.log(note);
'''


@contextmanager
def simulated_model(agent_dir):
    requests = []

    class Endpoint(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            if self.path != '/v1/chat/completions':
                return self.send_error(404)
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(body)
            if body.get('model') != MODEL or not body.get('stream'):
                return self.send_error(400, 'expected configured streaming model')
            chunks = []
            for delta, reason in [({'role': 'assistant', 'content': ANSWER}, None), ({}, 'stop')]:
                obj = {'id': 'local', 'object': 'chat.completion.chunk', 'model': MODEL,
                       'created': 1, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
                chunks.append('data: ' + json.dumps(obj) + '\n\n')
            data = (''.join(chunks) + 'data: [DONE]\n\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    with ThreadingHTTPServer(('127.0.0.1', 0), Endpoint) as httpd:
        provider = {'baseUrl': f'http://127.0.0.1:{httpd.server_port}/v1',
                    'api': 'openai-completions', 'apiKey': 'simulated-key-only', 'models': [{'id': MODEL}]}
        agent_dir.mkdir()
        for filename, config in [('models.json', {'providers': {'simulated': provider}}),
                                 ('settings.json', {'defaultProvider': 'simulated', 'defaultModel': MODEL})]:
            (agent_dir / filename).write_text(json.dumps(config), encoding='utf-8')
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield requests
        finally:
            httpd.shutdown()
            thread.join()


class WorkAcceptance(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='ursi-work-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        self.home = self.root / 'data/flow-runtime'
        self.agent_dir = self.root / 'pi'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.root), 'LANG': 'C.UTF-8',
                    'PI_CODING_AGENT_DIR': str(self.agent_dir), 'URSI_API_TOKEN': secrets.token_hex(32),
                    'URSI_LISTEN_ADDR': f'127.0.0.1:{self.port}', 'URSI_DATA_DIR': str(self.home.parent),
                    'URSI_WORKSPACE_DIR': str(self.workspace)}

    @contextmanager
    def server(self, *, flow):
        daemon = self.root / 'intentionally-absent-flowd'
        if flow:
            daemon = self.root / 'flowd'
            target = BINS.daemon.resolve(strict=True)
            daemon.write_text('#!/bin/sh\nexec node ' + shlex.quote(str(target)) + ' "$@"\n', encoding='utf-8')
            daemon.chmod(0o700)
        env = dict(self.env, URSI_FLOWD_BIN=str(daemon), URSI_FLOW_ENABLED=str(int(flow)))
        with tempfile.TemporaryFile('w+') as log:
            proc = subprocess.Popen([BINS.server.resolve(strict=True)], env=env, cwd=self.root,
                                    stdout=log, stderr=log, start_new_session=True)
            try:
                deadline = time.monotonic() + 15
                while True:
                    if proc.poll() is not None or time.monotonic() > deadline:
                        log.seek(0)
                        self.fail(f'server not ready: exit={proc.poll()} {log.read()}')
                    try:
                        self.get('/v2/items')
                        break
                    except (ConnectionRefusedError, ConnectionResetError):
                        time.sleep(.05)
                self.assertEqual((self.home / 'runtime.sock').is_socket(), flow)
                yield
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        self.assertEqual(proc.wait(timeout=15), 0, 'server shutdown')
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait()
                        raise

    def http(self, method, path, body=None, *, status=200, text=False):
        conn = HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request(method, '/api' + path, json.dumps(body) if body is not None else None,
                         {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.env['URSI_API_TOKEN']})
            response = conn.getresponse()
            data = response.read().decode()
            self.assertEqual(response.status, status, f'{method} {path}: {data}')
            if status == 200:
                return data if text else json.loads(data)
        finally:
            conn.close()

    def post(self, path, body, **kw):
        return self.http('POST', path, body, **kw)

    def get(self, path, **kw):
        return self.http('GET', path, **kw)

    def publish(self, kind, body, revision=1):
        doc = self.post('/v2/' + kind, body)
        self.assertEqual(doc['revision'], revision)
        self.assertEqual(self.get(f'/v2/{kind}/{body["id"]}/revisions/{revision}'), doc)
        return {'id': doc['id'], 'revision': revision}

    def package(self, name, executor, revision=1):
        return self.publish('packages', {'id': name, 'sop': SOP, 'acceptance': 'review the report',
                            'deliverables': ['report.txt'], 'actions': {'inspect': {'executor': executor}}}, revision)

    def item(self, package, note):
        item = self.post('/v2/items', {'package': package['id'], 'revision': package['revision'],
                         'requestId': note, 'input': {'note': note}})
        self.assertEqual(item['status'], 'pending')
        path = '/v2/items/' + item['id']
        self.assertEqual(self.post(path + '/start', {'assignee': 'operator'})['status'], 'working')
        return path

    def execute(self, path):
        base = path + '/attempts'
        started = self.post(base, {'action': 'inspect'})
        deadline = time.monotonic() + 45
        while True:
            attempt = self.get(base + '/' + started['id'])
            if attempt['status'] not in ('running', 'starting'):
                self.assertEqual(attempt['status'], 'succeeded', attempt)
                self.assertEqual(self.get(path)['status'], 'working')
                return attempt
            self.assertLess(time.monotonic(), deadline, f'timeout: {attempt}')
            time.sleep(.1)

    def test_agent(self):
        """Flow off: real Pi CLI, simulated loopback model, two independent reviews and restart."""
        pi = shutil.which(BINS.pi)
        self.assertIsNotNone(pi, f'real Pi CLI not found: {BINS.pi}')
        self.env['URSI_AGENT_BIN'] = os.path.abspath(pi)
        notes = [f'ticket-{i}-{secrets.token_hex(4)}' for i in range(2)]
        reports = []
        with simulated_model(self.agent_dir) as requests:
            with self.server(flow=False):
                guide = self.publish('resources', {'id': 'guide', 'kind': 'prompt', 'content': GUIDE})
                exe = self.publish('executors', {'id': 'assistant', 'kind': 'agent', 'resources': [guide]})
                pkg = self.package('triage', exe)
                paths = [self.item(pkg, note) for note in notes]
                self.assertNotEqual(*paths)
                # Publish before executing the old items, so a latest-version lookup is observable.
                new = self.publish('resources', {'id': 'guide', 'kind': 'prompt', 'content': 'NEW-GUIDE-v2'}, 2)
                new_exe = self.publish('executors', {'id': 'assistant', 'kind': 'agent', 'resources': [new]}, 2)
                self.package('triage', new_exe, 2)
                for i, path in enumerate(paths):
                    attempt = self.execute(path)
                    self.assertEqual(len(requests), i + 1)
                    user = json.dumps([m['content'] for m in requests[i]['messages'] if m['role'] == 'user'], ensure_ascii=False)
                    for required in ('inspect', SOP, GUIDE, notes[i]):
                        self.assertIn(required, user)
                    for forbidden in ('NEW-GUIDE-v2', notes[1 - i]):
                        self.assertNotIn(forbidden, user)
                    self.assertEqual(attempt['output'].strip(), ANSWER)
                    self.assertEqual(attempt['executor']['revision'], 1)
                    report = notes[i] + ': ' + attempt['output'].strip()
                    delivery = self.post(path + '/deliveries', {'files': {'report.txt': report}, 'attemptIds': [attempt['id']]})
                    self.assertEqual(delivery['status'], 'review')
                    self.post(path + '/deliveries/1/review', {'reviewer': 'reviewer', 'decision': ['accept', 'reject'][i],
                              'comment': ['', 'missing evidence'][i]})
                    reports.append(report)
                saved = [self.get(path) for path in paths]
            with self.server(flow=False):
                for i, path in enumerate(paths):
                    item = self.get(path)
                    self.assertEqual(item, saved[i])
                    self.assertEqual(item['revision'], 1)
                    self.assertEqual(item['input'], {'note': notes[i]})
                    self.assertEqual(item['status'], ['delivered', 'working'][i])
                    self.assertEqual(item['acceptedVersion'], [1, None][i])
                    attempt, = item['attempts']
                    delivery, = item['deliveries']
                    self.assertEqual(delivery['attemptIds'], [attempt['id']])
                    self.assertEqual(delivery['review']['decision'], ['accept', 'reject'][i])
                    self.assertEqual(delivery['review']['comment'], ['', 'missing evidence'][i])
                    self.assertEqual(self.get(path + '/deliveries/1/files/report.txt', text=True), reports[i])
                    self.assertEqual([row['id'] for row in self.get('/v2/items?status=' + item['status'])], [item['id']])
                self.assertEqual(len(requests), 2)

    def cli(self, *args):
        result = subprocess.run([BINS.cli.resolve(strict=True), *args], cwd=self.workspace, timeout=10,
                                env=dict(self.env, URSI_FLOW_HOME=str(self.home)), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_flow(self):
        """Flow on: shared pinned executor, v1/CLI history equality and no node effects on conflict."""
        files = {'FLOW.md': FLOW, 'scripts/task.mjs': SCRIPT}
        with self.server(flow=True):
            rev = self.post('/v1/flows', {'id': 'verify', 'files': files})['revision']
            executor = {'id': 'runner', 'kind': 'flow', 'flowId': 'verify', 'flowRevision': rev}
            pin = self.publish('executors', executor)
            ok = self.item(self.package('alpha', pin), 'alpha-note')
            queued = self.item(self.package('beta', pin), 'beta-note')
            self.assertEqual(self.get(ok)['packageSnapshot']['actions'], self.get(queued)['packageSnapshot']['actions'])
            attempt = self.execute(ok)
            run = attempt['id']
            self.assertEqual(attempt['backendRunId'], run)
            history = self.get(f'/v1/runs/{run}/history')
            self.assertEqual(history, self.cli('run', 'history', run))
            job = history['job']
            self.assertEqual((job['id'], job['revision'], job['status']), (run, rev, 'completed'))
            node, = history['nodeRuns']
            self.assertEqual(node['nodeRef'], 'work')
            self.assertEqual(node['commandResult']['stdout'].strip(), 'alpha-note')
            effects = self.workspace / 'effects'
            self.assertEqual(effects.read_text(), 'alpha-note\n')
            current = self.http('PUT', '/v1/flows/verify', {'expectedRevision': rev, 'files': {
                **files, 'references/version.md': 'revision two'}})['revision']
            self.assertNotEqual(current, rev)
            updated = self.publish('executors', {**executor, 'flowRevision': current}, 2)
            self.package('beta', updated, 2)
            self.post(queued + '/attempts', {'action': 'inspect'}, status=409)
            rejected, = self.get(queued + '/attempts')
            self.assertEqual(rejected['status'], 'failed')
            self.assertEqual(rejected['executor']['flowRevision'], rev)
            self.assertEqual(self.get(queued)['status'], 'working')
            self.get(f'/v1/runs/{rejected["id"]}/history', status=404)
            self.assertEqual(self.get('/v1/runs'), [job])
            self.assertEqual(self.cli('run', 'history', run), history)
            self.assertEqual(effects.read_text(), 'alpha-note\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', choices=('agent', 'flow', 'both'), default='both')
    parser.add_argument('--server', type=Path, default=ROOT / 'target/debug/ursi-server')
    parser.add_argument('--pi', default='pi', help='installed real Pi CLI')
    parser.add_argument('--daemon', type=Path, default=ROOT / 'flow-runtime/dist/machine/daemon.js')
    parser.add_argument('--cli', type=Path, default=ROOT / 'flow-runtime/client/target/debug/ursi-flow')
    BINS = parser.parse_args()
    stages = ('agent', 'flow') if BINS.stage == 'both' else [BINS.stage]
    suite = unittest.TestSuite(WorkAcceptance('test_' + stage) for stage in stages)
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
