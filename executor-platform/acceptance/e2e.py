"""Real HTTP services, Workbench-managed daemon, and local stdio ACP backends."""
from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4

from backend import (CANCEL_INSTRUCTION, DELAYED_ACK, EARLY_MESSAGE, EARLY_TOOL, ECHO_ONLY,
                     FOREIGN_MESSAGE, INVALID_FLOW, LOST_ACK, RECEIPT_TOOL, REPLY_TEXT,
                     STALE_IDLE, STALE_MESSAGE)

BACKEND_ID = 'fixture'

HERE = Path(__file__).resolve().parent
BUILD = HERE / '.build'
BIN = BUILD / 'target/debug'
REF = {'id': 'reviewer', 'revision': 1}


class Api:
    def __init__(self, port, token):
        self.origin = f'http://127.0.0.1:{port}'
        self.auth = {} if token is None else {'Authorization': 'Bearer ' + token}
        self.http = build_opener(ProxyHandler({}))

    def request(self, method, path, body=None, *, expected=None):
        headers = self.auth.copy()
        if isinstance(body, bytes):
            headers['Content-Type'] = 'application/octet-stream'
        elif body is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body).encode()
        req = Request(self.origin + '/api/' + path, data=body, headers=headers, method=method)
        try:
            response = self.http.open(req, timeout=22)
        except HTTPError as e:
            response = e
        with response:
            raw = response.read()
            if expected is not None and response.status == expected:
                return
            if expected is not None or not 200 <= response.status < 300:
                raise AssertionError(f'{method} {path}: HTTP {response.status}: {raw[:512]!r}')
            return json.loads(raw) if raw and 'application/json' in response.headers.get('Content-Type', '') else raw


def port():
    with socket.socket() as sock:
        sock.bind(('', 0))
        return sock.getsockname()[1]


def stop(proc):
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(8)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


class PlatformCase(unittest.TestCase):
    @classmethod
    def start_service(cls, name, env, api, ready_path):
        # Allow-list avoids inheriting a developer's provider or platform credentials.
        proc = subprocess.Popen([BIN / name], cwd=cls.root, env={
            'PATH': os.environ['PATH'], 'HOME': str(cls.root), 'LANG': 'C.UTF-8', **env})
        cls.addClassCleanup(stop, proc)
        deadline = time.monotonic() + 18
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f'{name} exited {proc.returncode} before readiness')
            try:
                api.request('GET', ready_path)
                return proc
            except URLError:
                time.sleep(.1)
        raise TimeoutError(f'{name}: {ready_path}')

    @classmethod
    def setUpClass(cls):
        run = tempfile.TemporaryDirectory(dir=HERE, prefix='.run-')
        cls.addClassCleanup(run.cleanup)
        cls.root = Path(run.name)

    @classmethod
    def start_platform(cls, backend, provider):
        admin, cls.wb_token, cls.rt_token = [uuid4().hex for _ in range(3)]
        platform_port = port()
        cls.management = Api(platform_port, admin)
        cls.anonymous = Api(platform_port, None)
        cls.runtime = Api(platform_port, cls.rt_token)
        cls.consumer = Api(platform_port, cls.wb_token)
        policy = cls.root / 'policy.json'
        policy.write_text(json.dumps({'models': [{'id': 'fixture', 'provider': provider}], 'tools': []}),
                          encoding='utf-8')
        policy.chmod(0o600)
        manifest = cls.root / 'backends.json'
        manifest.write_text(json.dumps([{'id': BACKEND_ID, 'label': '验收后端', 'bin': str(backend),
                                         'capabilities': ['flowOutcome']}]), encoding='utf-8')
        manifest.chmod(0o600)
        cls.platform_data = cls.root / 'platform'
        cls.platform_env = {
            'URSI_EXECUTOR_PLATFORM_LISTEN_ADDR': f'0.0.0.0:{platform_port}',
            'URSI_EXECUTOR_PLATFORM_ADMIN_TOKEN': admin,
            'URSI_EXECUTOR_PLATFORM_WORKBENCH_TOKEN': cls.wb_token,
            'URSI_EXECUTOR_PLATFORM_RUNTIME_TOKEN': cls.rt_token,
            'URSI_EXECUTOR_PLATFORM_DATA_DIR': str(cls.platform_data),
            'URSI_AGENT_BACKENDS': str(manifest), 'URSI_PI_POLICY': str(policy),
        }
        cls.launch_platform()

    @classmethod
    def launch_platform(cls):
        cls.platform = cls.start_service('ursi-executor-platform', cls.platform_env,
                                        cls.management, 'v2/agent-backends')

    @classmethod
    def publish_revisions(cls):
        management = cls.management.request
        check = management('POST', f'v2/agent-backends/{BACKEND_ID}/check')
        if check['status'] != 'ready':
            raise AssertionError(f'ACP probe failed: {check}')
        pkg = management('POST', 'v2/patches/config', {'name': 'acceptance'})
        cls.pinned_prompt = 'pinned-' + uuid4().hex
        for rev, prompt in enumerate([cls.pinned_prompt, 'replacement-' + uuid4().hex], 1):
            management('PUT', f"v2/directories/{pkg['directoryId']}/file?path=AGENTS.md&replace=true", prompt.encode())
            pub = management('POST', 'v2/executors', {'id': REF['id'], 'agent': {'configPackageId': pkg['id'], 'backendId': BACKEND_ID}})
            if pub['revision'] != rev:
                raise AssertionError(f'expected revision {rev}, got {pub}')

    def start_attempt(self, api, instruction, *, marker=None, run_config=None):
        attempt = str(uuid4())
        path = 'v2/executor-attempts/' + attempt
        body = {'executorRef': REF, 'workInstruction': {'encoding': 'utf-8', 'text': instruction}}
        if marker is not None:
            body['inputs'] = [{'kind': 'file', 'path': 'material.txt',
                               'contentBase64': b64encode(marker.encode()).decode()}]
        if run_config is not None:
            body['runConfig'] = run_config
        self.assertEqual(api.request('PUT', path, body)['attemptId'], attempt)
        return attempt, path, body

    def attempt_dir(self, attempt):
        return self.platform_data / 'executor-workspaces' / attempt

    def wait_attempt(self, api, path, attempt, status):
        deadline = time.monotonic() + 15
        while True:
            result = api.request('GET', path)
            self.assertEqual(result['attemptId'], attempt)
            if result['status'] == status:
                return result
            self.assertNotIn(result['status'], ('succeeded', 'failed', 'cancelled'), result)
            if time.monotonic() >= deadline:
                self.fail(f'{path}: expected {status}, got {result}')
            time.sleep(.1)

    def events(self, api, path, after=0, *, wait_ms=None):
        endpoint = f'{path}/events?after={after}'
        if wait_ms is not None:
            endpoint += f'&waitMs={wait_ms}'
        page = api.request('GET', endpoint)
        self.assertIsInstance(page['events'], list)
        cursor = after
        for event in page['events']:
            seq = event['seq']
            self.assertIs(type(seq), int)
            self.assertGreater(seq, cursor)
            cursor = seq
        self.assertIs(type(page['nextCursor']), int)
        self.assertEqual(page['nextCursor'], cursor)
        return page

    def rpc_steps(self, events):
        result = []
        for event in events:
            if event['kind'] == 'rpc':
                self.assertEqual(set(event), {'seq', 'kind', 'method', 'phase'}, event)
                result.append((event['method'], event['phase']))
        return result

    def wait_events(self, api, path, predicate):
        deadline = time.monotonic() + 15
        while True:
            page = self.events(api, path)
            if predicate(page['events']):
                return page
            if time.monotonic() >= deadline:
                self.fail(f'{path}: expected event not observed: {page}')
            time.sleep(.1)

    def wait_running_event(self, api, path):
        return self.wait_events(api, path, lambda events: any(e.get('state') == 'running' for e in events))

    def verify_events(self, owner, other, path, tool, reply=REPLY_TEXT):
        endpoint = path + '/events?after=0'
        self.anonymous.request('GET', endpoint, expected=401)
        for api in (other, self.management):
            api.request('GET', path, expected=404)
            api.request('GET', endpoint, expected=404)
        page = self.events(owner, path)
        self.assertGreaterEqual(len(page['events']), 2, page)
        encoded = json.dumps(page['events'])
        self.assertIn(reply, encoded)
        self.assertTrue(any(event.get('name') == tool for event in page['events']), page)
        self.assertNotIn(self.pinned_prompt, encoded)
        first = page['events'][0]['seq']
        self.assertEqual(self.events(owner, path, first), {
            'events': page['events'][1:], 'nextCursor': page['nextCursor']})
        self.assertEqual(self.events(owner, path, page['nextCursor']), {
            'events': [], 'nextCursor': page['nextCursor']})
        return page


class Integration(PlatformCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.start_platform(HERE / 'backend.py', {})
        cls.publish_revisions()

        browser, wb_port = uuid4().hex, port()
        cls.wb = Api(wb_port, browser)
        cls.start_service('ursi-server', {
            'URSI_DATA_DIR': str(cls.root / 'wb'),
            'URSI_EXECUTOR_PLATFORM_URL': cls.management.origin, 'URSI_EXECUTOR_PLATFORM_TOKEN': cls.wb_token,
            'URSI_API_TOKEN': browser, 'URSI_LISTEN_ADDR': f'0.0.0.0:{wb_port}',
        }, cls.wb, 'v2/work-items')

    def verify_receipt(self, api, directory, attempt, marker):
        data = api.request('GET', f'v2/directories/{directory}/file?path=receipt.json')
        self.assertEqual(json.loads(data), {'attempt': attempt, 'marker': marker, 'prompt': self.pinned_prompt})

    def verify_fixture_calls(self, attempt, *, cancel=False):
        calls = (self.attempt_dir(attempt) / 'fixture-methods').read_text(encoding='utf-8').splitlines()
        expected = ['initialize', 'session/new', 'session/prompt']
        if cancel or (cancel is None and 'session/cancel' in calls):
            expected.append('session/cancel')
        self.assertEqual(calls, expected + ['session/close'])

    def test_direct(self):
        wb = self.wb.request
        patch = wb('POST', 'v2/patches/work', {'name': 'direct'})
        marker = 'e2e-work-' + uuid4().hex
        wb('PUT', f"v2/directories/{patch['directoryId']}/file?path=material.txt", marker.encode())
        attempt = str(uuid4())
        path = 'v2/executor-attempts/' + attempt
        body = {'workPatchId': patch['id'], 'executorRef': REF,
                'workInstruction': {'encoding': 'utf-8', 'text': '读取材料文件并生成回执。'}}
        self.assertEqual(wb('PUT', path, body)['attemptId'], attempt)
        self.wait_running_event(self.consumer, path)
        receipt = self.wait_attempt(self.wb, path, attempt, 'succeeded')
        self.verify_receipt(self.wb, receipt['artifactDirectoryId'], attempt, marker)
        self.assertEqual(self.consumer.request('GET', path)['attemptId'], attempt)
        events = self.verify_events(self.consumer, self.runtime, path, RECEIPT_TOOL)
        self.assertEqual(wb('PUT', path, body), receipt)
        wb('PUT', f"v2/directories/{patch['directoryId']}/file?path=material.txt&replace=true", b'changed input')
        self.assertEqual(wb('PUT', path, body), receipt)  # Retry uses the original snapshot.
        other_patch = wb('POST', 'v2/patches/work', {'name': 'different work package'})
        wb('PUT', path, {**body, 'workPatchId': other_patch['id']}, expected=409)
        self.assertEqual(self.events(self.consumer, path), events)
        wb('POST', path + '/cancel')  # A late cancellation must preserve success.
        self.assertEqual(wb('GET', path), receipt)
        self.verify_receipt(self.wb, receipt['artifactDirectoryId'], attempt, marker)

    def test_delayed_ack_and_early_updates(self):
        owner = self.consumer
        marker = 'delayed ACK material'
        attempt, path, body = self.start_attempt(owner, DELAYED_ACK, marker=marker)
        self.wait_running_event(owner, path)
        receipt = self.wait_attempt(owner, path, attempt, 'succeeded')
        self.verify_receipt(owner, receipt['artifactDirectoryId'], attempt, marker)
        page = self.verify_events(owner, self.runtime, path, RECEIPT_TOOL)
        events = page['events']
        updates = [e for e in events if e['kind'] != 'rpc']
        self.assertEqual([(e['kind'], e.get('state'), e.get('name'), e.get('text')) for e in updates[:4]], [
            ('state', 'idle', None, None), ('tool', None, EARLY_TOOL, None),
            ('message', None, None, EARLY_MESSAGE), ('state', 'running', None, None),
        ])
        self.assertEqual(self.rpc_steps(events), [
            (method, phase) for method in ('initialize', 'session/new', 'session/prompt', 'session/close')
            for phase in ('sent', 'ack')
        ])
        late_ack = next(e['seq'] for e in events if e.get('method') == 'session/prompt' and e['phase'] == 'ack')
        self.assertLess(next(e['seq'] for e in events if e.get('stopReason') == 'end_turn'), late_ack)
        private = json.loads((self.attempt_dir(attempt) / 'acp-session.json').read_text(encoding='utf-8'))
        encoded = json.dumps(events)
        for value in (FOREIGN_MESSAGE, DELAYED_ACK, private['sessionId'],
                      private['idempotencyKey'], private['messageId']):
            self.assertNotIn(value, encoded)
        self.assertEqual(owner.request('PUT', path, body), receipt)
        self.verify_fixture_calls(attempt)

    def test_lost_ack(self):
        owner = self.consumer
        for instruction, expected in [(ECHO_ONLY, 'succeeded'), (LOST_ACK, 'unverified')]:
            with self.subTest(status=expected):
                marker = 'lost ACK material'
                attempt, path, body = self.start_attempt(owner, instruction, marker=marker)
                # Wait for the terminal update, not an inspect immediately after reservation.
                page = self.wait_events(owner, path, lambda events: any(
                    e.get('state') == 'idle' and e.get('stopReason') == 'end_turn' for e in events))
                self.assertTrue(any(e.get('state') == 'running' for e in page['events']), page)
                if expected == 'unverified':
                    self.wait_events(owner, path, lambda events: any(e['kind'] == 'gap' for e in events))
                receipt = self.wait_attempt(owner, path, attempt, expected)
                if expected == 'succeeded':
                    self.verify_receipt(owner, receipt['artifactDirectoryId'], attempt, marker)
                else:
                    self.assertTrue((self.attempt_dir(attempt) / 'workspace/artifacts/receipt.json').is_file())
                    self.assertIsNone(receipt.get('artifactDirectoryId'), receipt)
                prompt_steps = [phase for method, phase in self.rpc_steps(self.events(owner, path)['events'])
                                if method == 'session/prompt']
                self.assertEqual(prompt_steps, ['sent', 'failed'])
                self.assertEqual(owner.request('PUT', path, body), receipt)
                self.verify_fixture_calls(attempt, cancel=None if expected == 'unverified' else False)

    def test_stale_idle(self):
        owner = self.consumer
        marker = 'stale idle material'
        attempt, path, _ = self.start_attempt(owner, STALE_IDLE, marker=marker)
        release = self.attempt_dir(attempt) / 'fixture-release'
        try:
            page = self.wait_events(owner, path, lambda events: any(e.get('text') == STALE_MESSAGE for e in events))
            self.assertFalse(any(e.get('state') == 'running' for e in page['events']), page)
            state = owner.request('GET', path)
            self.assertEqual(state['status'], 'running', state)
            self.assertIsNone(state.get('artifactDirectoryId'), state)
        finally:
            release.touch()
        receipt = self.wait_attempt(owner, path, attempt, 'succeeded')
        self.verify_receipt(owner, receipt['artifactDirectoryId'], attempt, marker)
        tail = self.events(owner, path, page['nextCursor'])['events']
        self.assertEqual([(e['state'], e.get('stopReason')) for e in tail if e['kind'] == 'state'],
                         [('running', None), ('idle', 'end_turn')])
        self.verify_fixture_calls(attempt)

    def test_restart_and_cancel(self):
        owner = self.consumer
        attempt, path, body = self.start_attempt(owner, CANCEL_INSTRUCTION)
        running = self.wait_events(owner, path, lambda events: any(
            e.get('name') == RECEIPT_TOOL and e.get('status') == 'in_progress' for e in events))
        self.assertTrue(any(e.get('state') == 'running' for e in running['events']), running)
        self.assertEqual(owner.request('GET', path)['status'], 'running')
        cls = type(self)
        stop(cls.platform)
        cls.launch_platform()
        self.assertEqual(owner.request('GET', path)['status'], 'running')
        self.assertEqual(owner.request('PUT', path, body)['status'], 'running')
        self.assertEqual(self.events(owner, path), running)
        self.runtime.request('POST', path + '/cancel', expected=404)
        owner.request('POST', path + '/cancel')
        record = self.wait_attempt(owner, path, attempt, 'cancelled')
        tail = self.events(owner, path, running['nextCursor'])
        self.assertTrue(any(e.get('stopReason') == 'cancelled' for e in tail['events']), tail)
        self.assertNotIn(REPLY_TEXT, json.dumps(tail['events']))
        self.assertEqual(owner.request('PUT', path, body), record)
        self.verify_fixture_calls(attempt, cancel=True)

    def test_events_wait_does_not_block_cancel(self):
        owner = self.consumer
        attempt, path, _ = self.start_attempt(owner, CANCEL_INSTRUCTION)
        self.addCleanup(owner.request, 'POST', path + '/cancel')
        running = self.wait_events(owner, path, lambda events: any(
            e.get('name') == RECEIPT_TOOL and e.get('status') == 'in_progress' for e in events))
        cursor = running['nextCursor']
        endpoint = f'{path}/events?after={cursor}&waitMs=8000'
        self.anonymous.request('GET', endpoint, expected=401)
        for api in (self.runtime, self.management):
            api.request('GET', endpoint, expected=404)

        start = time.monotonic()
        self.assertEqual(self.events(owner, path, wait_ms=8000), running)
        self.assertLess(time.monotonic() - start, 4)
        empty = {'events': [], 'nextCursor': cursor}
        start = time.monotonic()
        self.assertEqual(self.events(owner, path, cursor, wait_ms=200), empty)
        self.assertGreaterEqual(time.monotonic() - start, .15)

        # A cursor beyond the remaining frames can only wake on worker exit.
        future_cursor = cursor + 64
        with ThreadPoolExecutor(max_workers=2) as pool:
            update = pool.submit(self.events, owner, path, cursor, wait_ms=8000)
            stopped = pool.submit(self.events, owner, path, future_cursor, wait_ms=8000)
            with self.assertRaises(FutureTimeout):
                update.result(timeout=.25)
            with self.assertRaises(FutureTimeout):
                stopped.result(timeout=.25)
            start = time.monotonic()
            owner.request('POST', path + '/cancel')
            self.assertLess(time.monotonic() - start, 4, 'events wait delayed cancellation')
            self.assertIn(('session/cancel', 'sent'), self.rpc_steps(update.result(timeout=4)['events']))
            self.assertEqual(stopped.result(timeout=4), {'events': [], 'nextCursor': future_cursor})
        self.wait_attempt(owner, path, attempt, 'cancelled')
        tail = self.events(owner, path, cursor)
        self.assertEqual(self.rpc_steps(tail['events']), [
            ('session/cancel', 'sent'), ('session/close', 'sent'), ('session/close', 'ack'),
        ])
        self.verify_fixture_calls(attempt, cancel=True)

    def test_worker_crash_is_unverified(self):
        owner = self.consumer
        attempt, path, body = self.start_attempt(owner, CANCEL_INSTRUCTION)
        page = self.wait_running_event(owner, path)
        ids = (self.attempt_dir(attempt) / 'fixture-pids').read_text(encoding='ascii')
        worker, agent = map(int, ids.split())
        os.kill(worker, signal.SIGKILL)
        result = self.wait_attempt(owner, path, attempt, 'unverified')
        self.assertIsNone(result.get('artifactDirectoryId'))
        tail = self.events(owner, path, page['nextCursor'])
        self.assertEqual(sum(e.get('reason') == 'worker_lost' for e in tail['events']), 1)
        self.assertEqual(self.events(owner, path, tail['nextCursor'])['events'], [])
        self.assertEqual(owner.request('PUT', path, body), result)
        calls = self.attempt_dir(attempt) / 'fixture-methods'
        self.assertEqual(calls.read_text(encoding='utf-8').splitlines().count('session/prompt'), 1)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if Path(f'/proc/{agent}/stat').read_text().rsplit(')', 1)[1].split()[0] == 'Z':
                    break
            except FileNotFoundError:
                break
            time.sleep(.02)
        else:
            self.fail('managed ACP Agent survived worker death')

    def test_invalid_flow_artifact_is_not_published(self):
        contract = {'outcomes': ['通过'], 'variables': ['回执']}
        attempt, path, _ = self.start_attempt(self.runtime, INVALID_FLOW, run_config={'nodeContract': contract})
        self.wait_events(self.runtime, path, lambda events: any(e.get('stopReason') == 'end_turn' for e in events))
        receipt = self.wait_attempt(self.runtime, path, attempt, 'failed')
        self.assertIsNone(receipt.get('artifactDirectoryId'), receipt)
        self.verify_fixture_calls(attempt)

class RpcFailureIntegration(PlatformCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        backend = cls.root / 'reject-session'
        fixture = str(HERE / 'backend.py')
        backend.write_text(f'''#!/usr/bin/python3
import json, os
if 'URSI_ACP_JOB' not in os.environ:
    os.execv({fixture!r}, [{fixture!r}])
init = json.loads(input())
assert init['method'] == 'initialize'
caps = dict(session=dict(systemPrompt=dict(mode=dict(override={{}}))))
result = dict(protocolVersion=2, info=dict(name='fixture', version='2'), capabilities=caps)
print(json.dumps(dict(jsonrpc='2.0', id=init['id'], result=result)), flush=True)
req = json.loads(input())
assert req['method'] == 'session/new'
print(json.dumps(dict(jsonrpc='2.0', id=req['id'], error=dict(
    code=-32603, message='private ACP failure text', data=req['params']))), flush=True)
''', encoding='utf-8')
        backend.chmod(0o700)
        cls.start_platform(backend, {})
        cls.publish_revisions()

    def test_rpc_error_stays_private(self):
        owner = self.consumer
        attempt, path, _ = self.start_attempt(owner, 'private instruction')
        self.wait_attempt(owner, path, attempt, 'failed')
        events = self.events(owner, path)['events']
        self.assertEqual(self.rpc_steps(events), [
            ('initialize', 'sent'), ('initialize', 'ack'), ('session/new', 'sent'), ('session/new', 'failed'),
        ])
        encoded = json.dumps(events)
        for secret in ('private ACP failure text', self.pinned_prompt, str(self.attempt_dir(attempt))):
            self.assertNotIn(secret, encoded)


if __name__ == '__main__':
    unittest.main()
