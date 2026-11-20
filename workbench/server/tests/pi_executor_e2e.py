#!/usr/bin/env python3
"""真实 Workbench HTTP → stdio MCP → Pi SDK 验收，仅模型使用本机 SSE 服务。

从仓库根目录运行（Linux，Node >=22.19）：
    (cd flow-runtime && npm run build)
    cargo build --locked --manifest-path workbench/Cargo.toml -p ursi-server
    python3 workbench/server/tests/pi_executor_e2e.py
"""
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
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
SERVER = ROOT / 'workbench/target/debug/ursi-server'
ADAPTER = ROOT / 'flow-runtime/dist/pi-executor/stdio.js'
PROFILE = 'managed-e2e'
MODEL = 'local-fixture'
API_KEY = 'fixture-only-pi-key'
MATERIAL = '工单材料：T-123'


class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls.append((self.path, self.headers.get('Authorization'), body))
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        if body['messages'][-1]['role'] == 'user':
            delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call_input', 'type': 'function',
                     'function': {'name': 'read_input', 'arguments': json.dumps({'path': 'ticket.txt'})}}]}
            reason = 'tool_calls'
        else:
            delta = {'role': 'assistant', 'content': self.server.answer}
            reason = 'stop'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for part, finish in [(delta, None), ({}, reason)]:
            chunk = {'id': 'pi-e2e', 'object': 'chat.completion.chunk', 'model': MODEL,
                     'choices': [{'index': 0, 'delta': part, 'finish_reason': finish}]}
            self.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode())
        self.wfile.write(b'data: [DONE]\n\n')

    def log_message(self, *_):
        pass


def definition(prompt, skill_revision):
    return {'id': 'ticket-review', 'resources': [{'id': 'guide', 'revision': skill_revision}],
            'agent': {'systemPrompt': prompt, 'modelProfile': PROFILE, 'tools': []}}


class PiAcceptance(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='ursi-pi-e2e-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.token = secrets.token_hex(32)
        self.model = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        self.model.calls = []
        self.model.answer = '# 核查报告\n' + secrets.token_hex(12)
        thread = threading.Thread(target=self.model.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.model.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.model.shutdown)

        self.policy = self.root / 'policy.json'
        provider = {'model': MODEL, 'apiKey': API_KEY,
                    'baseUrl': f'http://127.0.0.1:{self.model.server_port}/v1'}
        with os.fdopen(os.open(self.policy, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600),
                       'w', encoding='utf-8') as f:
            json.dump({'models': [{'id': PROFILE, 'provider': provider}], 'tools': []}, f)
        self.wrapper = self.root / 'pi-executor'
        node = shutil.which('node')
        self.assertIsNotNone(node, '需要 Node >=22.19')
        cmd = shlex.join([str(Path(node).resolve()), str(ADAPTER.resolve(strict=True))])
        self.wrapper.write_text(f'#!/bin/sh\nexec {cmd}\n', encoding='utf-8')
        self.wrapper.chmod(0o700)

    @contextmanager
    def workbench(self, enabled=True):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        env = {'HOME': str(self.root), 'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8',
               'URSI_API_TOKEN': self.token, 'URSI_LISTEN_ADDR': f'127.0.0.1:{self.port}',
               'URSI_DATA_DIR': str(self.root / 'data'), 'URSI_FLOW_ENABLED': '0',
               'URSI_PI_POLICY': str(self.policy)}
        if enabled:
            env['URSI_PI_EXECUTOR_BIN'] = str(self.wrapper)
        log = self.root / 'workbench.log'
        with log.open('wb') as out:
            proc = subprocess.Popen([SERVER.resolve(strict=True)], cwd=self.root, env=env, stdout=out, stderr=out)
        try:
            deadline = time.monotonic() + 10
            while True:
                if proc.poll() is not None:
                    self.fail(f'Workbench 启动失败：{log.read_text(encoding="utf-8")[-2000:]}')
                try:
                    self.http('GET', '/work-items')
                    break
                except ConnectionRefusedError:
                    if time.monotonic() >= deadline:
                        self.fail('等待 Workbench HTTP 超时')
                    time.sleep(.05)
            yield
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                self.fail('Workbench 退出超时')

    def http(self, method, path, body=None, *, status=range(200, 300), raw=False):
        conn = HTTPConnection('127.0.0.1', self.port, timeout=25)
        headers = {'Authorization': 'Bearer ' + self.token}
        if isinstance(body, bytes):
            headers['Content-Type'] = 'application/octet-stream'
        elif body is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body, ensure_ascii=False).encode()
        try:
            conn.request(method, '/api/v2' + path, body, headers)
            response = conn.getresponse()
            data = response.read()
            self.assertIn(response.status, status, f'{method} {path}: HTTP {response.status} {data.decode(errors="replace")}')
            return data if raw or not data or response.status >= 400 else json.loads(data)
        finally:
            conn.close()

    def skill(self, text):
        return self.http('POST', '/resources', {'id': 'guide', 'kind': 'skill', 'content': text})['revision']

    def request(self, note, **target):
        patch = self.http('POST', '/patches/work', {'name': '工单样例'})
        self.http('PUT', f'/directories/{patch["directoryId"]}/file?path=ticket.txt', MATERIAL.encode())
        return dict(target, workPatchId=patch['id'], workInstruction={'text': note, 'encoding': 'utf-8'})

    def verify_run(self, key, body, prompt, skill, *, retry=False, absent=()):
        path = '/executor-attempts/' + key
        receipt = self.http('PUT', path, body)
        self.assertEqual(receipt['attemptId'], key)
        if retry:
            self.assertEqual(self.http('PUT', path, body)['attemptId'], key)
        deadline = time.monotonic() + 60
        while True:
            done = self.http('GET', path)
            if done['status'] not in ('starting', 'running'):
                break
            if time.monotonic() >= deadline:
                self.fail(f'等待执行终态超时：{done}')
            time.sleep(.2)
        self.assertEqual(done['status'], 'succeeded', done)
        self.assertEqual((done['attemptId'], done['backendRunRef'], done['artifactDirectoryRef']),
                         (key, 'pi:' + key, 'artifacts:' + key))
        if retry:
            replay = self.http('PUT', path, body)
            self.assertEqual((replay['status'], replay['artifactDirectoryId']), ('succeeded', done['artifactDirectoryId']))
        report = f'/directories/{done["artifactDirectoryId"]}/file?path=answer.md'
        self.assertEqual(self.http('GET', report, raw=True), self.model.answer.encode())
        self.http('PUT', report + '&replace=true', b'changed', status=(409,))
        # One Pi session: a tool request, then one final response with the actual input.
        self.assertEqual(len(self.model.calls), 2, '每次尝试应仅有一轮读材料和一轮作答')
        for route, auth, request in self.model.calls:
            self.assertEqual((route, auth, request['model']), ('/v1/chat/completions', 'Bearer ' + API_KEY, MODEL))
        first, second = [call[2]['messages'] for call in self.model.calls]
        self.assertEqual(first[0]['role'], 'system')
        system = json.dumps(first[0]['content'], ensure_ascii=False)
        for text in (prompt, skill):
            self.assertIn(text, system)
        for text in absent:
            self.assertNotIn(text, system)
        self.assertEqual(first[-1]['role'], 'user')
        note = body['workInstruction']['text']
        self.assertIn(first[-1]['content'], (note, [{'type': 'text', 'text': note}]))
        self.assertEqual(second[-1]['role'], 'tool')
        self.assertIn(MATERIAL, json.dumps(second[-1]['content'], ensure_ascii=False))

    def test_preview_without_publication(self):
        with self.workbench():
            skill = '按草稿清单逐项核对。'
            prompt = '使用草稿报告格式。'
            draft = definition(prompt, self.skill(skill))
            body = self.request('试跑本次样例。', previewDefinition=draft)
            self.verify_run(str(uuid.uuid4()), body, prompt, skill)
            self.assertEqual(self.http('GET', '/executors'), [])
            self.assertEqual(self.http('POST', '/executors', draft)['revision'], 1,
                             '试跑不应占用修订号')

    def test_pinned_revision_and_idempotency(self):
        with self.workbench():
            old_skill, new_skill = '执行首版核对规则。', '执行新版评级规则。'
            old_prompt, new_prompt = '使用首版摘要格式。', '使用新版表格格式。'
            refs = []
            for prompt, skill in [(old_prompt, old_skill), (new_prompt, new_skill)]:
                published = self.http('POST', '/executors', definition(prompt, self.skill(skill)))
                refs.append({k: published[k] for k in ('id', 'revision')})
            self.assertEqual([ref['revision'] for ref in refs], [1, 2])
            key = str(uuid.uuid4())
            body = self.request('执行正式核查。', executorRef=refs[0])
            self.verify_run(key, body, old_prompt, old_skill, retry=True, absent=(new_prompt, new_skill))
            for changed in [{'executorRef': refs[1]}, {'workInstruction': {'text': '其他任务', 'encoding': 'utf-8'}}]:
                self.http('PUT', '/executor-attempts/' + key, {**body, **changed}, status=(409,))
            self.assertEqual(len(self.model.calls), 2)

    def test_pi_driver_disabled(self):
        with self.workbench(enabled=False):
            draft = definition('已配置但未启用运行器。', self.skill('检查样例。'))
            published = self.http('POST', '/executors', draft)
            ref = {k: published[k] for k in ('id', 'revision')}
            body = self.request('不应调用模型。', executorRef=ref)
            self.http('PUT', '/executor-attempts/' + str(uuid.uuid4()), body, status=(503,))
            self.assertEqual(self.model.calls, [])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--server', type=Path, default=SERVER)
    parser.add_argument('--adapter-js', type=Path, default=ADAPTER)
    args = parser.parse_args()
    SERVER, ADAPTER = args.server, args.adapter_js
    unittest.main(argv=[__file__], verbosity=2)
