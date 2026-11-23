"""Real HTTP services, Workbench-managed daemon, and local stdio ACP backends."""
from base64 import b64encode
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
from openai_stub import ANSWER, API_KEY, INPUT_PATH, MODEL, OpenAIStub

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
        cls.platform_data = cls.root / 'platform'
        cls.platform_env = {
            'URSI_EXECUTOR_PLATFORM_LISTEN_ADDR': f'0.0.0.0:{platform_port}',
            'URSI_EXECUTOR_PLATFORM_ADMIN_TOKEN': admin,
            'URSI_EXECUTOR_PLATFORM_WORKBENCH_TOKEN': cls.wb_token,
            'URSI_EXECUTOR_PLATFORM_RUNTIME_TOKEN': cls.rt_token,
            'URSI_EXECUTOR_PLATFORM_DATA_DIR': str(cls.platform_data),
            'URSI_PI_EXECUTOR_BIN': str(backend), 'URSI_PI_POLICY': str(policy),
        }
        cls.launch_platform()

    @classmethod
    def launch_platform(cls):
        cls.platform = cls.start_service('ursi-executor-platform', cls.platform_env,
                                        cls.management, 'v2/agent-backends')

    @classmethod
    def publish_revisions(cls):
        management = cls.management.request
        check = management('POST', 'v2/agent-backends/pi/check')
        if check['status'] != 'ready':
            raise AssertionError(f'ACP probe failed: {check}')
        pkg = management('POST', 'v2/patches/config', {'name': 'acceptance'})
        cls.pinned_prompt = 'pinned-' + uuid4().hex
        for rev, prompt in enumerate([cls.pinned_prompt, 'replacement-' + uuid4().hex], 1):
            management('PUT', f"v2/directories/{pkg['directoryId']}/file?path=AGENTS.md&replace=true", prompt.encode())
            pub = management('POST', 'v2/executors', {'id': REF['id'], 'agent': {'configPackageId': pkg['id'], 'backendId': 'pi'}})
            if pub['revision'] != rev:
                raise AssertionError(f'expected revision {rev}, got {pub}')

    def start_attempt(self, api, instruction, *, marker=None, run_config=None):
        attempt = str(uuid4())
        path = 'v2/executor-attempts/' + attempt
        body = {'executorRef': REF, 'workInstruction': {'encoding': 'utf-8', 'text': instruction}}
        if marker is not None:
            body['inputs'] = [{'kind': 'file', 'path': INPUT_PATH,
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

    def events(self, api, path, after=0):
        page = api.request('GET', f'{path}/events?after={after}')
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

        # Workbench gives the spawned daemon its own consumer credential.
        launcher = cls.root / 'flowd'
        node = shlex.quote(shutil.which('node'))
        daemon = shlex.quote(str(BUILD / 'runtime/machine/daemon.js'))
        launcher.write_text(f'#!/bin/sh\nexec {node} {daemon}\n', encoding='utf-8')
        launcher.chmod(0o700)
        (cls.root / 'workspace').mkdir()
        browser, wb_port = uuid4().hex, port()
        cls.wb = Api(wb_port, browser)
        cls.start_service('ursi-server', {
            'URSI_FLOW_ENABLED': '1', 'URSI_FLOWD_BIN': str(launcher),
            'URSI_DATA_DIR': str(cls.root / 'wb'), 'URSI_WORKSPACE_DIR': str(cls.root / 'workspace'),
            'URSI_EXECUTOR_PLATFORM_URL': cls.management.origin, 'URSI_EXECUTOR_PLATFORM_TOKEN': cls.wb_token,
            'URSI_EXECUTOR_PLATFORM_RUNTIME_TOKEN': cls.rt_token, 'URSI_API_TOKEN': browser,
            'URSI_LISTEN_ADDR': f'0.0.0.0:{wb_port}',
        }, cls.wb, 'v1/flows')

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
        self.assertEqual([(e['kind'], e.get('state'), e.get('name'), e.get('text')) for e in events[:4]], [
            ('state', 'idle', None, None), ('tool', None, EARLY_TOOL, None),
            ('message', None, None, EARLY_MESSAGE), ('state', 'running', None, None),
        ])
        self.assertNotIn(FOREIGN_MESSAGE, json.dumps(events))
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

    def test_flow(self):
        wb = self.wb.request
        wb('POST', 'v1/flows', {'id': 'audit', 'files': {'FLOW.md': (HERE / 'FLOW.md').read_text()}})
        marker = 'e2e-flow-' + uuid4().hex
        job = wb('POST', 'v1/flows/audit/runs', {'workspace': 'default', 'variables': {'材料': marker}, 'executorRef': REF})
        self.assertEqual(job['executorRef'], REF)
        run = 'v1/runs/' + job['id']
        deadline = time.monotonic() + 35
        while job['status'] == 'running' and time.monotonic() < deadline:
            time.sleep(.2)
            job = wb('GET', run)
        history = wb('GET', run + '/history')
        self.assertEqual(job['status'], 'completed', (job.get('error'), history.get('nodeRuns')))
        nodes = history['nodeRuns']
        self.assertEqual([n['nodeRef'] for n in nodes], ['review', 'rework'])
        self.assertEqual(nodes[0]['outcome'], {'result': '退回', 'variables': {'回执': marker}})
        decision = history['routeDecisions'][0]
        self.assertEqual((decision['sourceNodeRunId'], decision['result'], decision['destination']),
                         (nodes[0]['id'], '退回', {'kind': 'node', 'ref': 'rework'}))
        attempt = nodes[0]['attemptId']
        path = 'v2/executor-attempts/' + attempt
        receipt = self.runtime.request('GET', path)
        self.assertEqual(receipt['status'], 'succeeded')
        self.assertEqual(receipt['attemptId'], attempt)
        self.verify_receipt(self.runtime, receipt['artifactDirectoryId'], attempt, marker)
        self.verify_events(self.runtime, self.consumer, path, 'submit_flow_outcome')


class PiIntegration(PlatformCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.stub = OpenAIStub()
        cls.addClassCleanup(cls.stub.close)
        cls.launch_log = cls.root / 'pi-launches'
        launcher = cls.root / 'ursi-pi-executor-acp'
        node = shlex.quote(shutil.which('node'))
        acp = BUILD / 'runtime/pi-executor/acp.js'
        if not acp.is_file():
            raise FileNotFoundError(f'{acp}: build via acceptance/run.sh')
        # Platform clears PATH and HOME; use an absolute Node path and a private home.
        launcher.write_text(f'#!/bin/sh\nset -eu\nexport HOME={shlex.quote(str(cls.root))}\n'
                            f'printf "%s\\n" "${{URSI_ACP_JOB:-probe}}" >> {shlex.quote(str(cls.launch_log))}\n'
                            f'exec {node} {shlex.quote(str(acp))}\n', encoding='utf-8')
        launcher.chmod(0o700)
        cls.start_platform(launcher, cls.stub.provider)

    def test_preflight_and_direct(self):
        self.publish_revisions()
        self.assertEqual(self.launch_log.read_text(encoding='utf-8').splitlines(), ['probe'])
        self.assertEqual(self.stub.requests, [], 'preflight must not call a model')
        instruction = 'Read the input material and write an answer.'
        marker = 'real-pi-material-' + uuid4().hex
        attempt, path, body = self.start_attempt(self.consumer, instruction, marker=marker)
        self.wait_running_event(self.consumer, path)
        result = self.wait_attempt(self.consumer, path, attempt, 'succeeded')
        answer = self.consumer.request('GET', f"v2/directories/{result['artifactDirectoryId']}/file?path=answer.md")
        self.assertEqual(answer.decode(), ANSWER)
        page = self.verify_events(self.consumer, self.runtime, path, 'read_input', reply=ANSWER)
        self.assertNotIn(API_KEY, json.dumps(page['events']))
        self.assertNotIn(marker, json.dumps(page['events']))
        self.assertEqual(self.consumer.request('PUT', path, body), result)
        changed = [{'kind': 'file', 'path': INPUT_PATH, 'contentBase64': b64encode(b'changed input').decode()}]
        self.consumer.request('PUT', path, {**body, 'inputs': changed}, expected=409)
        self.assertEqual(self.launch_log.read_text(encoding='utf-8').splitlines(),
                         ['probe', str(self.attempt_dir(attempt) / 'acp-job.json')])
        self.assertEqual(len(self.stub.requests), 2, self.stub.requests)
        first, second = [request[2] for request in self.stub.requests]
        self.assertEqual(first['model'], MODEL)
        self.assertIn(self.pinned_prompt, json.dumps(first['messages'][0]))
        self.assertEqual(first['messages'][0]['role'], 'system')
        self.assertIn(instruction, json.dumps(first['messages'][-1]))
        self.assertEqual(first['messages'][-1]['role'], 'user')
        self.assertIn('read_input', [tool['function']['name'] for tool in first['tools']])
        self.assertEqual(second['messages'][-1]['role'], 'tool')
        self.assertIn(marker, json.dumps(second['messages'][-1]))


if __name__ == '__main__':
    unittest.main()
