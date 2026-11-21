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
DEFAULT_MODEL = 'local-policy-first'
TOOL = 'tickets.get'
API_KEY = 'fixture-only-pi-key'
MATERIAL = '工单材料：T-123'
PI = 'pi'
LOCAL = 'local-review'
LOCAL_LABEL = '本机核查运行器'


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
            chunk = {'id': 'pi-e2e', 'object': 'chat.completion.chunk', 'model': body['model'],
                     'choices': [{'index': 0, 'delta': part, 'finish_reason': finish}]}
            self.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode())
        self.wfile.write(b'data: [DONE]\n\n')

    def log_message(self, *_):
        pass


def definition(package, backend=None):
    agent = {'configPackageId': package['id']}
    if backend is not None:
        agent['backendId'] = backend
    return {'id': 'ticket-review', 'agent': agent}


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
            models = [{'id': 'z-default', 'provider': {**provider, 'model': DEFAULT_MODEL}},
                      {'id': PROFILE, 'provider': provider}]
            tool = {'id': TOOL, 'name': 'getTicket', 'readOnly': True, 'inputSchema': {'type': 'object'},
                    'url': f'http://127.0.0.1:{self.model.server_port}/mcp'}
            json.dump({'models': models, 'tools': [tool]}, f)
        node = shutil.which('node')
        self.assertIsNotNone(node, '需要 Node >=22.19')
        cmd = shlex.join([str(Path(node).resolve()), str(ADAPTER.resolve(strict=True))])
        # Both paths speak the real Pi protocol. Observe stdin without answering any frames.
        for backend in (PI, LOCAL):
            wrapper = self.root / backend
            trace = self.root / f'{backend}.jsonl'
            trace.touch(mode=0o600)
            wrapper.write_text(f'#!/bin/sh\ntee -a {shlex.quote(str(trace))} | {cmd}\n', encoding='utf-8')
            wrapper.chmod(0o700)
        self.registry = self.root / 'agent-backends.json'
        with os.fdopen(os.open(self.registry, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600),
                       'w', encoding='utf-8') as f:
            json.dump([{'id': LOCAL, 'label': LOCAL_LABEL, 'bin': str(self.root / LOCAL),
                        'capabilities': ['skills']}], f)

    @contextmanager
    def workbench(self, enabled=True, *, second=False):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        env = {'HOME': str(self.root), 'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8',
               'URSI_API_TOKEN': self.token, 'URSI_LISTEN_ADDR': f'127.0.0.1:{self.port}',
               'URSI_DATA_DIR': str(self.root / 'data'), 'URSI_FLOW_ENABLED': '0',
               'URSI_PI_POLICY': str(self.policy)}
        if enabled:
            env['URSI_PI_EXECUTOR_BIN'] = str(self.root / PI)
        if second:
            env['URSI_AGENT_BACKENDS'] = str(self.registry)
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

    def backends(self, package=None):
        path = '/agent-backends'
        if package is not None:
            path += '?configPackageId=' + package['id']
        rows = self.http('GET', path)
        self.assertIsInstance(rows, list)
        by_id = {}
        for row in rows:
            backend = row['id']
            self.assertNotIn(backend, by_id)
            self.assertIsInstance(backend, str)
            self.assertIsInstance(row['label'], str)
            self.assertTrue(row['label'])
            if package is not None:
                self.assertIsInstance(row['compatible'], bool)
            self.assertIsInstance(row['capabilities'], list)
            self.assertLessEqual(set(row['capabilities']), {'skills', 'tools'})
            self.assertIsInstance(row['configured'], bool)
            self.assertIn(row['status'], ('unchecked', 'ready', 'failed'))
            if row['status'] == 'unchecked':
                self.assertIsNone(row['checkedAt'])
            else:
                self.assertGreater(row['checkedAt'], 0)
            self.assertNotIn('bin', row)
            self.assertNotIn(str(self.root), json.dumps(row))
            by_id[backend] = row
        return by_id

    def frames(self, backend):
        trace = (self.root / f'{backend}.jsonl').read_text(encoding='utf-8')
        return [json.loads(line) for line in trace.splitlines()]

    def check(self, backend):
        other = LOCAL if backend == PI else PI
        previous, untouched = len(self.frames(backend)), self.frames(other)
        calls = len(self.model.calls)
        result = self.http('POST', f'/agent-backends/{backend}/check')
        self.assertEqual((result['id'], result['status']), (backend, 'ready'), result)
        self.assertEqual(self.backends()[backend], result)
        methods = [frame['method'] for frame in self.frames(backend)[previous:]]
        self.assertIn('initialize', methods)
        self.assertIn('tools/list', methods)
        self.assertNotIn('tools/call', methods)
        self.assertEqual(self.frames(other), untouched, '单项检查不能启动另一后端')
        self.assertEqual(len(self.model.calls), calls, '检查不应调用模型')

    def reject_definition(self, draft, inputs, *, status):
        before = {b: self.frames(b) for b in (PI, LOCAL)}
        self.http('POST', '/executors', draft, status=(status,))
        self.http('PUT', '/executor-attempts/' + str(uuid.uuid4()),
                  {**inputs, 'previewDefinition': draft}, status=(status,))
        self.assertEqual({b: self.frames(b) for b in before}, before, '被拒绝的定义不能启动运行器')

    def config_package(self, name, prompt, skill, **options):
        package = self.http('POST', '/patches/config', {'name': name})
        self.http('POST', f'/directories/{package["directoryId"]}/dir', {'path': 'skills/guide'})
        self.update_config(package, prompt, skill, **options)
        return package

    def update_config(self, package, prompt, skill, **options):
        files = {'AGENTS.md': prompt, 'skills/guide/SKILL.md': skill,
                 'mcp.json': json.dumps({'mcpServers': {}, **options})}
        for path, text in files.items():
            self.http('PUT', f'/directories/{package["directoryId"]}/file?path={path}&replace=true', text.encode())

    def request(self, note, *, work_config=None, **target):
        spec = {'name': '工单样例'}
        if work_config is not None:
            spec['configPackage'] = {'id': work_config['id']}
        patch = self.http('POST', '/patches/work', spec)
        if work_config is not None:
            self.assertEqual(patch['configPackage'], spec['configPackage'])
        self.http('PUT', f'/directories/{patch["directoryId"]}/file?path=ticket.txt', MATERIAL.encode())
        return dict(target, workPatchId=patch['id'], workInstruction={'text': note, 'encoding': 'utf-8'})

    def verify_run(self, key, body, prompt, skill, *, backend=PI, model=DEFAULT_MODEL,
                   business_tools=(), retry=False, absent=()):
        start = len(self.model.calls)
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
        for candidate in (PI, LOCAL):
            calls = [f['params']['name'] for f in self.frames(candidate) if f['method'] == 'tools/call'
                     and f['params']['arguments']['attemptId'] == key]
            if candidate == backend:
                self.assertIn('executor_start', calls)
                self.assertIn('executor_inspect', calls)
            else:
                self.assertEqual(calls, [], '同一尝试的任何调用都不能改走另一后端')
        report = f'/directories/{done["artifactDirectoryId"]}/file?path=answer.md'
        self.assertEqual(self.http('GET', report, raw=True), self.model.answer.encode())
        self.http('PUT', report + '&replace=true', b'changed', status=(409,))
        # One Pi session: a tool request, then one final response with the actual input.
        calls = self.model.calls[start:]
        self.assertEqual(len(calls), 2, '每次尝试应仅有一轮读材料和一轮作答')
        for route, auth, request in calls:
            self.assertEqual((route, auth, request['model']), ('/v1/chat/completions', 'Bearer ' + API_KEY, model))
        tools = [item['function'] for item in calls[0][2]['tools']]
        business = [tool for tool in tools if tool['name'] not in ('list_inputs', 'read_input')]
        self.assertEqual(len(business), len(business_tools), business)
        for tool_id in business_tools:
            self.assertTrue(any(tool_id in tool['description'] for tool in business), business)
        first, second = [call[2]['messages'] for call in calls]
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
            draft = definition(self.config_package('试跑配置', prompt, skill))
            inputs = self.request('试跑本次样例。')
            self.assertEqual(self.backends()[PI]['status'], 'unchecked')
            self.reject_definition(draft, inputs, status=503)
            self.check(PI)
            self.verify_run(str(uuid.uuid4()), {**inputs, 'previewDefinition': draft}, prompt, skill)
            self.assertEqual(self.http('GET', '/executors'), [])
            published = self.http('POST', '/executors', draft)
            self.assertEqual((published['revision'], published['agent']['backendId']), (1, PI))

    def test_pinned_revision_and_idempotency(self):
        with self.workbench(second=True):
            old_skill, new_skill = '执行首版核对规则。', '执行新版评级规则。'
            old_prompt, new_prompt = '使用首版摘要格式。', '使用新版表格格式。'
            package = self.config_package('核查配置', old_prompt, old_skill, modelProfile=PROFILE, tools=[TOOL])
            draft = definition(package)
            old_ref = {'id': draft['id'], 'revision': 1}
            new_ref = {'id': draft['id'], 'revision': 2}
            directory = self.backends()
            self.assertEqual({k for k, v in directory.items() if v['configured']}, {PI, LOCAL})
            self.assertCountEqual(directory[PI]['capabilities'], ['skills', 'tools'])
            self.assertEqual(directory[LOCAL]['capabilities'], ['skills'])
            self.assertEqual(directory[LOCAL]['label'], LOCAL_LABEL)
            self.assertEqual(directory[LOCAL]['status'], 'unchecked')
            self.check(PI)
            self.assertEqual(self.backends()[LOCAL]['status'], 'unchecked')
            self.check(LOCAL)
            # Both adapters are healthy, but only Pi is advertised to accept business tools.
            self.assertEqual({k: v['compatible'] for k, v in self.backends(package).items()}, {PI: True, LOCAL: False})
            inputs = self.request('检查工具兼容性。')
            self.reject_definition(definition(package, LOCAL), inputs, status=400)
            published = self.http('POST', '/executors', draft)
            self.assertEqual((published['revision'], published['agent']['backendId']), (1, PI))
            self.update_config(package, new_prompt, new_skill)
            self.assertEqual({k: v['compatible'] for k, v in self.backends(package).items()}, {PI: True, LOCAL: True})

            other_prompt, other_skill = '工作包引用的固定指令。', '工作包引用的核查规则。'
            other = self.config_package('工作包自带配置', other_prompt, other_skill)
            inputs = self.request('核查同一份工单。', work_config=other)
            stale = (old_prompt, old_skill, other_prompt, other_skill)
            self.reject_definition(draft, inputs, status=409)
            selected = definition(package, LOCAL)
            preview_key = str(uuid.uuid4())
            preview = {**inputs, 'previewDefinition': selected}
            self.verify_run(preview_key, preview, new_prompt, new_skill, backend=LOCAL, retry=True, absent=stale)
            self.http('PUT', '/executor-attempts/' + preview_key,
                      {**inputs, 'previewDefinition': definition(package, PI)}, status=(409,))
            published = self.http('POST', '/executors', selected)
            self.assertEqual((published['revision'], published['agent']['backendId']), (2, LOCAL))
            for ref, backend in [(old_ref, PI), (new_ref, LOCAL)]:
                revision = self.http('GET', f'/executors/{ref["id"]}/revisions/{ref["revision"]}')
                self.assertEqual(revision['agent']['backendId'], backend)

            key = str(uuid.uuid4())
            body = {**inputs, 'executorRef': old_ref}
            self.verify_run(key, body, old_prompt, old_skill, model=MODEL, business_tools=(TOOL,), retry=True,
                            absent=(new_prompt, new_skill, other_prompt, other_skill))
            calls = len(self.model.calls)
            for changed in [{'executorRef': new_ref}, {'workInstruction': {'text': '其他任务', 'encoding': 'utf-8'}}]:
                self.http('PUT', '/executor-attempts/' + key, {**body, **changed}, status=(409,))
            self.assertEqual(len(self.model.calls), calls)
            self.verify_run(str(uuid.uuid4()), {**inputs, 'executorRef': new_ref}, new_prompt, new_skill,
                            backend=LOCAL, absent=stale)

        with self.workbench(second=True):
            self.assertEqual(self.backends()[LOCAL]['status'], 'unchecked')
            self.reject_definition(selected, inputs, status=503)
            self.verify_run(str(uuid.uuid4()), {**inputs, 'executorRef': new_ref}, new_prompt, new_skill,
                            backend=LOCAL, absent=stale)

    def test_failed_check(self):
        # Preserve a valid handshake and normal exit, but remove a required tool from tools/list.
        wrapper = self.root / LOCAL
        command = wrapper.read_text(encoding='utf-8').rstrip()
        wrapper.write_text(command + " | sed -u 's/executor_cancel/not_cancel/g'\n", encoding='utf-8')
        with self.workbench(second=True):
            self.check(PI)
            draft = definition(self.config_package('失败检查', '检查报告。', '检查规则。'), LOCAL)
            inputs = self.request('不能回退到已就绪的 Pi。')
            self.reject_definition(draft, inputs, status=503)
            result = self.http('POST', f'/agent-backends/{LOCAL}/check')
            directory = self.backends()
            self.assertEqual(result, directory[LOCAL])
            self.assertEqual((result['status'], directory[PI]['status']), ('failed', 'ready'))
            methods = [frame['method'] for frame in self.frames(LOCAL)]
            self.assertIn('tools/list', methods)
            self.assertNotIn('tools/call', methods)
            self.reject_definition(draft, inputs, status=503)
            self.assertEqual(self.model.calls, [])

    def test_pi_driver_disabled(self):
        with self.workbench():
            self.check(PI)
            draft = definition(self.config_package('禁用样例配置', '运行器禁用后不能执行。', '检查样例。'))
            published = self.http('POST', '/executors', draft)
            ref = {k: published[k] for k in ('id', 'revision')}
            inputs = self.request('不应调用模型。')
        with self.workbench(enabled=False):
            directory = self.backends()
            self.assertFalse(directory[PI]['configured'])
            self.assertEqual(directory[PI]['status'], 'unchecked')
            self.reject_definition(draft, inputs, status=503)
            self.http('PUT', '/executor-attempts/' + str(uuid.uuid4()), {**inputs, 'executorRef': ref}, status=(503,))
            self.assertEqual(self.model.calls, [])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--server', type=Path, default=SERVER)
    parser.add_argument('--adapter-js', type=Path, default=ADAPTER)
    args = parser.parse_args()
    SERVER, ADAPTER = args.server, args.adapter_js
    unittest.main(argv=[__file__], verbosity=2)
