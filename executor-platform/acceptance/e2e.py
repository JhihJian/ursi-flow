"""Real HTTP services, Workbench-managed daemon, local stdio backend only."""
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4

HERE = Path(__file__).resolve().parent
BUILD = HERE / '.build'
BIN = BUILD / 'target/debug'
REF = {'id': 'reviewer', 'revision': 1}


class Api:
    def __init__(self, port, token):
        self.origin = f'http://127.0.0.1:{port}'
        self.auth = {'Authorization': 'Bearer ' + token}
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
    proc.terminate()
    try:
        proc.wait(8)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


class Integration(unittest.TestCase):
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
                return
            except URLError:
                time.sleep(.1)
        raise TimeoutError(f'{name}: {ready_path}')

    @classmethod
    def setUpClass(cls):
        run = tempfile.TemporaryDirectory(dir=HERE, prefix='.run-')
        cls.addClassCleanup(run.cleanup)
        cls.root = Path(run.name)
        admin, wb_token, rt_token, browser = [uuid4().hex for _ in range(4)]
        platform_port = port()
        management = Api(platform_port, admin)
        cls.runtime = Api(platform_port, rt_token)
        cls.consumer = Api(platform_port, wb_token)
        policy = cls.root / 'policy.json'
        policy.write_text(json.dumps({'models': [{'id': 'fixture', 'provider': {}}], 'tools': []}))
        policy.chmod(0o600)
        cls.start_service('ursi-executor-platform', {
            'URSI_EXECUTOR_PLATFORM_LISTEN_ADDR': f'0.0.0.0:{platform_port}',
            'URSI_EXECUTOR_PLATFORM_ADMIN_TOKEN': admin,
            'URSI_EXECUTOR_PLATFORM_WORKBENCH_TOKEN': wb_token,
            'URSI_EXECUTOR_PLATFORM_RUNTIME_TOKEN': rt_token,
            'URSI_EXECUTOR_PLATFORM_DATA_DIR': str(cls.root / 'platform'),
            'URSI_PI_EXECUTOR_BIN': str(HERE / 'backend.py'), 'URSI_PI_POLICY': str(policy),
        }, management, 'v2/agent-backends')
        check = management.request('POST', 'v2/agent-backends/pi/check')
        if check['status'] != 'ready':
            raise RuntimeError(f'MCP probe failed: {check}')
        pkg = management.request('POST', 'v2/patches/config', {'name': 'acceptance'})
        cls.pinned_prompt = 'pinned-' + uuid4().hex
        for rev, prompt in enumerate([cls.pinned_prompt, 'replacement-' + uuid4().hex], 1):
            management.request('PUT', f"v2/directories/{pkg['directoryId']}/file?path=AGENTS.md&replace=true", prompt.encode())
            pub = management.request('POST', 'v2/executors', {'id': REF['id'], 'agent': {'configPackageId': pkg['id'], 'backendId': 'pi'}})
            if pub['revision'] != rev:
                raise AssertionError(f'expected revision {rev}, got {pub}')

        # Workbench gives the spawned daemon its own consumer credential.
        launcher = cls.root / 'flowd'
        node = shlex.quote(shutil.which('node'))
        daemon = shlex.quote(str(BUILD / 'runtime/machine/daemon.js'))
        launcher.write_text(f'#!/bin/sh\nexec {node} {daemon}\n')
        launcher.chmod(0o700)
        (cls.root / 'workspace').mkdir()
        wb_port = port()
        cls.wb = Api(wb_port, browser)
        cls.start_service('ursi-server', {
            'URSI_FLOW_ENABLED': '1', 'URSI_FLOWD_BIN': str(launcher),
            'URSI_DATA_DIR': str(cls.root / 'wb'), 'URSI_WORKSPACE_DIR': str(cls.root / 'workspace'),
            'URSI_EXECUTOR_PLATFORM_URL': management.origin, 'URSI_EXECUTOR_PLATFORM_TOKEN': wb_token,
            'URSI_EXECUTOR_PLATFORM_RUNTIME_TOKEN': rt_token, 'URSI_API_TOKEN': browser, 'URSI_LISTEN_ADDR': f'0.0.0.0:{wb_port}',
        }, cls.wb, 'v1/flows')

    def verify_receipt(self, api, directory, attempt, marker):
        data = api.request('GET', f'v2/directories/{directory}/file?path=receipt.json')
        self.assertEqual(json.loads(data), {'attempt': attempt, 'marker': marker, 'prompt': self.pinned_prompt})

    def test_direct(self):
        wb = self.wb.request
        patch = wb('POST', 'v2/patches/work', {'name': 'direct'})
        marker = 'e2e-work-' + uuid4().hex
        wb('PUT', f"v2/directories/{patch['directoryId']}/file?path=material.txt", marker.encode())
        attempt = str(uuid4())
        path = 'v2/executor-attempts/' + attempt
        wb('PUT', path, {'workPatchId': patch['id'], 'executorRef': REF,
                         'workInstruction': {'encoding': 'utf-8', 'text': '读取材料文件并生成回执。'}})
        receipt = wb('GET', path)
        self.assertEqual(receipt['status'], 'succeeded', receipt)
        self.assertEqual(receipt['attemptId'], attempt)
        self.verify_receipt(self.wb, receipt['artifactDirectoryId'], attempt, marker)
        self.assertEqual(self.consumer.request('GET', path)['attemptId'], attempt)
        self.runtime.request('GET', path, expected=404)

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
        self.verify_receipt(self.runtime, receipt['artifactDirectoryId'], attempt, marker)
        self.consumer.request('GET', path, expected=404)


if __name__ == '__main__':
    unittest.main()
