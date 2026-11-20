#!/usr/bin/env python3
"""Real Docker acceptance: sudo -n python3 -I -B ursi-sandbox/observer/tests/docker_acceptance.py

Uses the prebuilt debug binaries and gateway/tests/fixtures/docker image. No
image builds, host packet sockets, external HTTP services or published ports.
"""
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import struct
import subprocess
import tempfile
import time
from uuid import uuid4


BIN = Path(__file__).resolve().parents[2] / 'target/debug'
IMAGE = 'ursi-gateway-acceptance:local'
BASE = '/api/v1/sandboxes'
DOCKER_HOST = 'unix:///var/run/docker.sock'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'DOCKER_HOST': DOCKER_HOST}
BODY = b'gateway-acceptance\n'


def docker(*args):
    return subprocess.check_output(['docker', *args], env=ENV, timeout=40, text=True)


def wait(read, matches, description):
    until = time.monotonic() + 50
    while True:
        value = read()
        if matches(value):
            return value
        if time.monotonic() >= until:
            raise AssertionError(f'timeout waiting for {description}: {value!r}')
        time.sleep(0.15)


class Trial:
    def __init__(self, root):
        self.root = root
        self.scope = 'obs-' + uuid4().hex
        self.key = secrets.token_hex(32)
        self.children = {}
        self.port = None
        self.socket = root / 'observer/observer.sock'

    def launch(self, service, options, ready):
        assert service not in self.children
        log = self.root / f'{service}.log'
        with log.open('wb') as out:
            process_env = {**ENV, **options}
            command = ['sudo', '-n', 'env'] + [f'{key}={value}' for key, value in process_env.items()]
            command.append(str(BIN / f'ursi-{service}'))
            child = subprocess.Popen(command, cwd=self.root, env={'PATH': ENV['PATH']},
                                     stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                                     start_new_session=True)
        self.children[service] = child

        def check():
            assert child.poll() is None, f'{service} exited: {log.read_text()}'
            return ready(log)

        wait(check, bool, f'{service} readiness')

    def kill(self, service):
        child = self.children[service]
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=10)
        del self.children[service]

    def gateway(self):
        def ready(log):
            match = re.search(r'^ursi-gateway listening on 0\.0\.0\.0:(\d+)$',
                              log.read_text(), re.MULTILINE)
            if match:
                self.port = int(match[1])
                return True
        self.launch('gateway', {
            'URSI_GATEWAY_DRIVER': 'docker', 'URSI_GATEWAY_BIND': '0.0.0.0:0',
            'URSI_GATEWAY_NAMESPACE': self.scope, 'URSI_GATEWAY_KEY': self.key,
            'URSI_GATEWAY_DB': str(self.root / 'gateway.sqlite'),
            'URSI_GATEWAY_OBSERVER_SOCKET': str(self.socket),
        }, ready)
        assert self.api('GET', '/api/v1/capabilities')['observer_enabled'] is True

    def observer(self, limit=2**20):
        # A stale socket pathname survives SIGKILL; wait for a real listener.
        def ready(_log):
            with socket.socket(socket.AF_UNIX) as s:
                return s.connect_ex(str(self.socket)) == 0
        self.launch('observer', {'URSI_OBSERVER_DIR': str(self.socket.parent),
                                 'URSI_OBSERVER_LIMIT_BYTES': str(limit)}, ready)

    def api(self, method, path, expected=200, body=None, auth=True, retry_conflict=False):
        headers = {'Authorization': 'Bearer ' + self.key} if auth is True else (
            {'Authorization': 'Bearer wrong-key'} if auth == 'wrong' else {})
        if body is not None:
            headers['Content-Type'] = 'application/json'
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=12)
        try:
            conn.request(method, path, json.dumps(body) if body is not None else None, headers)
            res = conn.getresponse()
            data = res.read()
            if retry_conflict and res.status == 409:
                return None
            assert res.status == expected, (method, path, expected, res.status, data[:512])
            if res.status == 401:
                assert res.getheader('WWW-Authenticate') == 'Bearer'
            if '/segments/' in path and res.status == 200:
                assert res.getheader('Content-Type') == 'application/vnd.tcpdump.pcap'
                return data
            return json.loads(data)
        finally:
            conn.close()

    def settled(self, path, state):
        return wait(lambda: self.api('GET', path), lambda s: s['status'] == state and
                    s['operation'] is None, f'{path} {state}')

    def action(self, path, name, state, body=None):
        # The lifecycle reconciler may briefly hold this sandbox lock (409).
        wait(lambda: self.api('POST', path + '/' + name, 202, body, retry_conflict=True),
             bool, f'{name} accepted')
        return self.settled(path, state)

    def inspect_pair(self):
        objects = []
        namespaces = []
        for path in (self.a, self.b):
            s = self.settled(path, 'running')
            name = f"{self.scope}-{s['id']}-r{s['resource']['generation']}"
            obj, = json.loads(docker('container', 'inspect', name))
            labels = obj['Config']['Labels']
            assert labels['io.ursi.scope'] == self.scope and labels['io.ursi.id'] == s['id']
            assert obj['HostConfig']['NetworkMode'] in ('bridge', 'default')
            pid = obj['State']['Pid']
            assert obj['State']['Running'] and pid > 1
            namespaces.append(os.readlink(f'/proc/{pid}/ns/net'))
            objects.append(obj)
        host = os.readlink('/proc/1/ns/net')
        assert os.readlink('/proc/self/ns/net') == host
        assert len(set([host, *namespaces])) == 3, (host, namespaces)
        print(f'netns host/A/B: {host} {" ".join(namespaces)}', flush=True)
        return objects

    def begin(self):
        a, b = self.inspect_pair()  # Fail closed, including after every rebuild.
        rec = self.api('POST', self.a + '/observations', 202)
        assert rec['container'] == a['Id'] and rec['container_started_at'] == a['State']['StartedAt']
        assert rec['sandbox_id'] == self.a.rsplit('/', 1)[1]
        run = self.a + '/observations/' + rec['observation_id']
        self.state(run, 'running')
        return run, a, b

    def state(self, run, state):
        def matches(s):
            assert s['state'] != 'error', s
            return s['state'] == state and (state not in ('limited', 'stopped') or s['ended_ms'] is not None)
        return wait(lambda: self.api('GET', run), matches, f'{run} {state}')

    def packets(self, run, rec):
        frames = []
        size = 0
        for i in range(1, rec['segments'] + 1):
            data = self.api('GET', f'{run}/segments/{i}')
            frames.extend(parse_pcap(data))
            size += len(data)
        assert (size, len(frames)) == (rec['bytes'], rec['packets'])
        return frames

    def scoped(self, kind):
        flags = '-aq' if kind == 'container' else '-q'
        return docker(kind, 'ls', flags, '--filter', f'label=io.ursi.scope={self.scope}').splitlines()

    def cleanup(self):
        for service in list(self.children):
            self.kill(service)
        for kind in ('container', 'volume'):
            ids = self.scoped(kind)
            if ids:
                docker(kind, 'rm', '-f', *ids)
            assert not self.scoped(kind)
        print(f'cleaned {self.scope}: no containers or volumes', flush=True)


def parse_pcap(data):
    magic, major, minor, _, _, snaplen, link = struct.unpack_from('<IHHIIII', data)
    assert (magic, major, minor, link) == (0xa1b2c3d4, 2, 4, 276)
    offset = 24
    while offset < len(data):
        _, _, size, wire = struct.unpack_from('<IIII', data, offset)
        offset += 16
        assert 20 <= size <= min(snaplen, wire, len(data) - offset)
        frame = data[offset:offset + size]
        yield frame
        offset += size


def tcp(frame):
    # LINKTYPE_LINUX_SLL2 uses network order, independently of PCAP byte order.
    if frame[:2] != b'\x08\x00':
        return None
    index, _, direction = struct.unpack_from('!IHB', frame, 4)
    ip = frame[20:]
    if ip[0] >> 4 != 4 or ip[9] != 6:
        return None
    segment = ip[(ip[0] & 15) * 4:int.from_bytes(ip[2:4], 'big')]
    src, dst, seq = struct.unpack_from('!HHI', segment)
    return (index, direction, socket.inet_ntoa(ip[12:16]), socket.inet_ntoa(ip[16:20]),
            src, dst, seq, segment[(segment[12] >> 4) * 4:])


def get(container, host, marker):
    response = docker('exec', container, 'wget', '-Y', 'off', '-T', '3', '-qO-',
                      f'http://{host}:8080/{marker}')
    assert response.encode() == BODY


def isolation(t):
    obs = t.a + '/observations'
    t.inspect_pair()
    for auth in (False, 'wrong'):
        t.api('POST', obs, 401, auth=auth)
    run, a, b = t.begin()
    for method, path in [('GET', run), ('POST', run + '/stop'), ('GET', run + '/segments/1')]:
        for auth in (False, 'wrong'):
            t.api(method, path, 401, auth=auth)
    t.api('POST', obs, 409)
    t.api('GET', run + '/segments/1', 409)
    lo, eth = map(int, docker('exec', a['Id'], 'cat', '/sys/class/net/lo/ifindex',
                              '/sys/class/net/eth0/ifindex').split())
    assert lo != eth
    aip, bip = [str(ipaddress.IPv4Address(o['NetworkSettings']['Networks']['bridge']['IPAddress']))
                for o in (a, b)]
    assert aip != bip
    local, external, private = [uuid4().hex for _ in range(3)]
    t.kill('gateway')
    get(a['Id'], '127.0.0.1', local)
    get(a['Id'], bip, external)
    get(b['Id'], '127.0.0.1', private)
    t.gateway()
    assert t.api('GET', run)['state'] == 'running'
    t.api('POST', run + '/stop', 202)
    rec = t.state(run, 'stopped')
    assert rec['reason'] == 'requested'
    t.api('POST', run + '/stop', 200)
    frames = t.packets(run, rec)
    assert all(private.encode() not in f for f in frames)
    packets = [p for f in frames if (p := tcp(f))]
    # Same IP/TCP tuple, sequence and marked request in both cooked lo copies.
    copies = {p[1]: p[2:] for p in packets if p[0] == lo and p[2:4] == ('127.0.0.1',)*2
              and p[5] == 8080 and ('GET /' + local).encode() in p[-1]}
    assert 4 in copies and 0 in copies and copies[4] == copies[0], copies.keys()
    ports = {p[4] for p in packets if p[:4] == (eth, 4, aip, bip) and p[5] == 8080
             and ('GET /' + external).encode() in p[-1]}
    port, = ports
    response = [p[-1] for p in packets if p[:6] == (eth, 0, bip, aip, 8080, port)]
    assert any(b'HTTP/1.1 200 OK' in data for data in response) and any(BODY in data for data in response)
    print(f"PASS auth/conflict/stop, gateway downtime: {len(frames)} packets, {rec['bytes']} bytes; "
          f'lo ifindex={lo} directions=4,0; eth0 ifindex={eth} HTTP directions=4,0; B marker absent')


def lifecycle(t):
    old, first, _ = t.begin()
    t.action(t.a, 'stop', 'stopped')
    rec = t.state(old, 'stopped')
    assert rec['reason'] == 'container_exited'
    t.action(t.a, 'rebuild', 'running', {'preserve_data': True})
    new, second, _ = t.begin()
    active = t.api('GET', new)
    assert new != old and second['Id'] != first['Id'] and active['generation'] > rec['generation']
    assert t.api('GET', old) == rec
    t.kill('observer')
    for method, path in [('GET', new), ('POST', new + '/stop'), ('GET', old + '/segments/1'),
                         ('POST', t.a + '/observations')]:
        t.api(method, path, 503)
    assert docker('exec', second['Id'], 'echo', 'observer-offline') == 'observer-offline\n'
    t.action(t.a, 'stop', 'stopped')
    rebuilt = t.action(t.a, 'rebuild', 'running', {'preserve_data': True})
    assert rebuilt['resource']['generation'] > active['generation']
    limit = 8192
    t.observer(limit)
    recovered = t.state(new, 'interrupted')
    assert recovered['reason'] == 'observer_interrupted' and recovered['container'] == second['Id']
    print('PASS container exit/rebuild, observer SIGKILL: 503, exec/stop/rebuild, recovered interrupted')
    quota, current, _ = t.begin()
    for i in range(16):
        get(current['Id'], '127.0.0.1', f'quota-{i}')
        if t.api('GET', quota)['state'] == 'limited':
            break
        time.sleep(0.08)  # Allow complete records from the small transaction to flush.
    rec = t.state(quota, 'limited')
    assert 24 <= rec['bytes'] <= limit and rec['segments'] > 0
    frames = t.packets(quota, rec)
    print(f"PASS quota: {len(frames)} complete packets, {rec['bytes']}/{limit} bytes")


def main():
    if os.geteuid() != 0 or not __debug__:
        raise SystemExit(__doc__.splitlines()[0])
    signal.signal(signal.SIGTERM, lambda *_: exit_on_term())
    with tempfile.TemporaryDirectory(prefix='ursi-observer-test-') as directory:
        t = Trial(Path(directory))
        docker('image', 'inspect', '--format', '{{.Id}}', IMAGE)
        assert not t.scoped('container') and not t.scoped('volume')
        print(f'Docker scope={t.scope}', flush=True)
        try:
            t.gateway()
            spec = {'image': IMAGE}
            t.a, t.b = [BASE + '/' + t.api('POST', BASE, 202, spec)['id'] for _ in range(2)]
            assert t.a != t.b
            t.inspect_pair()  # Even observer startup is gated on real netns identities.
            t.observer()
            isolation(t)
            lifecycle(t)
        except BaseException:
            for log in t.root.glob('*.log'):
                print(f'{log.name}: {log.read_text()[-1500:]}', flush=True)
            raise
        finally:
            t.cleanup()


def exit_on_term():
    raise SystemExit(143)


if __name__ == '__main__':
    main()
