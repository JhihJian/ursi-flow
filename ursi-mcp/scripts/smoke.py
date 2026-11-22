#!/usr/bin/env python3
"""Exercise an extracted delivery from a separate working directory."""
import contextlib
import http.server
import json
import os
from pathlib import Path
import secrets
import select
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request


class Peer(http.server.BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        method = request['method']
        self.seen.append((method, self.headers.get('Authorization')))
        result = {
            'server/discover': {'resultType': 'complete', 'supportedVersions': ['2026-07-28'],
                                'capabilities': {'resources': {}}, 'ttlMs': 0, 'cacheScope': 'private',
                                '_meta': {'ursi/executorProtocol': '1',
                                          'io.modelcontextprotocol/serverInfo': {'name': 'delivery-smoke', 'version': '1'}}},
            'resources/list': {'resources': [{'name': 'Smoke', 'uri': 'memo:smoke'}]},
            'resources/read': {'contents': [{'uri': 'memo:smoke', 'text': 'standalone resource'}]},
        }[method]
        payload = json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


@contextlib.contextmanager
def run(binary, cwd, data, token_file):
    # No inherited PATH, Node, toolchain, or Workbench settings.
    env = {'URSI_MCP_BIND': '0.0.0.0:0', 'URSI_MCP_DATA_DIR': str(data),
           'URSI_MCP_TOKEN_FILE': str(token_file), 'SMOKE_TOKEN': 'not-a-platform-credential'}
    with subprocess.Popen([binary], cwd=cwd, env=env, stderr=subprocess.PIPE, text=True) as process:
        try:
            assert select.select([process.stderr], [], [], 10)[0], 'startup timed out'
            line = process.stderr.readline().strip()
            assert line.startswith('ursi-mcpd listening at '), line
            yield f'http://127.0.0.1:{line.rsplit(":", 1)[1]}'
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def check(binary, root, endpoint):
    data = root / 'data'
    data.mkdir(mode=0o700)
    token, credential = secrets.token_hex(32), secrets.token_hex(16)
    token_file = data / 'admin.token'
    token_file.touch(mode=0o600)
    token_file.write_text(token + '\n')
    policy = data / 'mcp-policy.json'
    credential_file = data / 'credentials.json'
    rotated = secrets.token_hex(16)

    def write_credentials(value):
        pending = credential_file.with_suffix('.tmp')
        pending.touch(mode=0o600)
        pending.write_text(json.dumps({'SMOKE_TOKEN': value}))
        pending.replace(credential_file)

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(url, path, method='GET', body=None, expected=200, auth=True, **headers):
        if auth:
            headers['Authorization'] = f'Bearer {token}'
        if body is not None:
            headers['Content-Type'] = 'application/json'
        payload = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url + path, data=payload, headers=headers, method=method)
        try:
            response = opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            assert response.status == expected, (path, response.status, expected)
            assert all(secret.encode() not in raw for secret in (token, credential, rotated)), path
            if response.headers.get_content_type() == 'application/json':
                return json.loads(raw)
            return raw

    api = '/api/v2'
    registry = api + '/mcp-servers'
    variables = api + '/platform-env'
    draft = {'name': 'Test service', 'url': endpoint, 'binding': 'platform', 'credentialEnv': 'SMOKE_TOKEN'}
    inline = {'name': 'Inline service', 'url': endpoint, 'binding': 'platform', 'credentialSecret': 'smoke-inline-secret'}
    with run(binary, root, data, token_file) as url:
        assert b'id="root"' in call(url, '/', auth=False)
        call(url, registry, expected=401, auth=False)
        call(url, api + '/unknown', expected=401, auth=False)
        call(url, api + '/unknown', expected=404)
        call(url, registry, expected=403, Origin='http://example.invalid')
        call(url, registry, expected=403, Host='example.invalid')
        call(url, '/platform-env', expected=404, auth=False)
        call(url, variables, expected=404)
        call(url, variables, 'POST', {'name': 'SMOKE_TOKEN', 'value': credential}, expected=404)
        call(url, variables + '/SMOKE_TOKEN', 'PUT', {'value': rotated}, expected=404)
        call(url, variables + '/SMOKE_TOKEN', 'DELETE', expected=404)
        call(url, registry, 'POST', draft, expected=400)
        policy.touch(mode=0o600)
        policy.write_text(json.dumps([{'url': endpoint, 'credentialEnv': 'SMOKE_TOKEN'}]))
        call(url, registry, 'POST', draft, expected=400)
        write_credentials(credential)
        row = call(url, registry, 'POST', draft)
        detail = registry + '/' + row['id']
        assert 'protocolCheck' not in row and call(url, registry) == [row]
        assert not Peer.seen
        # Inline secrets need an explicit allowSecret grant and never echo back.
        call(url, registry, 'POST', inline, expected=400)  # plain HTTP with secret is rejected before policy
        call(url, registry, 'POST', {**inline, 'credentialEnv': 'SMOKE_TOKEN', 'credentialSecret': 'x'}, expected=400)
        call(url, registry, 'POST', {**inline, 'credentialEnv': None, 'credentialSecret': 'bad token'}, expected=400)
        policy.write_text(json.dumps([{'url': endpoint, 'credentialEnv': 'SMOKE_TOKEN'},
                                      {'url': endpoint, 'allowSecret': True}]))
        inline_row = call(url, registry, 'POST', inline)
        assert inline_row['credentialSecret'] is True and 'smoke-inline-secret' not in json.dumps(inline_row)
        assert call(url, registry + '/' + inline_row['id'] + '/protocol-check', 'POST')['status'] == 'checked'
        assert any(auth == 'Bearer smoke-inline-secret' for _, auth in Peer.seen)
        call(url, registry + '/' + inline_row['id'], 'DELETE')
        call(url, detail + '/protocol-check', 'POST', expected=401, auth=False)
        rules_path = api + '/mcp-recognition-rules'
        assert call(url, rules_path) == [{'id': 'executor-v1', 'label': '执行器 v1', 'metaKey': 'ursi/executorProtocol', 'equals': '1'}]
        check_result = call(url, detail + '/protocol-check', 'POST')
        assert check_result['status'] == 'checked' and check_result['checkedAt'] > 0
        assert check_result['labels'] == ['执行器 v1']
        assert call(url, registry)[0]['protocolCheck'] == check_result
        custom = [{'id': 'executor-v1', 'label': '执行器 v1', 'metaKey': 'ursi/executorProtocol', 'equals': '1'},
                  {'id': 'smoke', 'label': '烟雾测试', 'metaKey': 'ursi/executorProtocol', 'equals': '1'}]
        assert call(url, rules_path, 'PUT', custom) == custom
        assert call(url, registry)[0].get('protocolCheck') is None
        check_result = call(url, detail + '/protocol-check', 'POST')
        assert check_result['labels'] == ['执行器 v1', '烟雾测试']
        assert call(url, rules_path, 'PUT', []) == []
        assert call(url, registry)[0].get('protocolCheck') is None
        check_result = call(url, detail + '/protocol-check', 'POST')
        assert check_result['labels'] == []
        assert call(url, registry)[0]['protocolCheck'] == check_result
        assert Peer.seen[-1] == ('server/discover', 'Bearer ' + credential)
        assert b'id="root"' in call(url, '/mcp-servers/' + row['id'] + '?uri=memo%3Asmoke', auth=False)
        assert call(url, detail + '/inspection')['resources'][0]['uri'] == 'memo:smoke'
        assert call(url, detail + '/resources/read', 'POST', {'uri': 'memo:smoke'})['contents'][0]['text'] == 'standalone resource'
        assert all(auth == 'Bearer ' + credential for _, auth in Peer.seen if auth != 'Bearer smoke-inline-secret')
        write_credentials(rotated)
        call(url, detail + '/inspection')
        assert Peer.seen[-1][1] == 'Bearer ' + rotated
        assert json.loads((data / 'store.json').read_text()).keys() == {'servers', 'rules'}
        credential_file.chmod(0o644)
        seen = len(Peer.seen)
        call(url, detail + '/inspection', expected=503)
        assert len(Peer.seen) == seen
        credential_file.chmod(0o600)
        settings = {'allowedTools': ['echo'], 'githubToolsets': [], 'githubReadOnly': False}
        assert call(url, detail + '/settings', 'PUT', settings) == settings
        call(url, detail + '/tools/call', 'POST', {'name': 'echo'}, expected=400)
        assert (data / 'store.json').stat().st_mode & 0o777 == 0o600
        locked = subprocess.run([binary], cwd=root, env={'URSI_MCP_DATA_DIR': str(data), 'URSI_MCP_TOKEN_FILE': str(token_file)}, capture_output=True, timeout=5)
        assert locked.returncode != 0 and '无法锁定'.encode() in locked.stderr
    with run(binary, root, data, token_file) as url:
        assert call(url, registry)[0]['settings'] == settings
        assert call(url, registry)[0]['id'] == row['id']
        assert call(url, registry)[0]['protocolCheck'] == check_result
        assert call(url, api + '/mcp-recognition-rules') == []
        call(url, detail + '/inspection')
        assert Peer.seen[-1][1] == 'Bearer ' + rotated
        credential_file.unlink()
        seen = len(Peer.seen)
        call(url, detail + '/inspection', expected=503)
        assert len(Peer.seen) == seen, 'deleted credential was used or taken from environment'
        policy.unlink()
        call(url, detail + '/inspection', expected=400)
        assert len(Peer.seen) == seen


def main():
    binary = Path(sys.argv[1]).resolve(strict=True)
    with tempfile.TemporaryDirectory() as directory, http.server.ThreadingHTTPServer(('127.0.0.1', 0), Peer) as peer:
        thread = threading.Thread(target=peer.serve_forever)
        thread.start()
        try:
            check(binary, Path(directory), f'http://127.0.0.1:{peer.server_port}/mcp')
        finally:
            peer.shutdown()
            thread.join()
    print('standalone bundle smoke passed')


if __name__ == '__main__':
    main()
