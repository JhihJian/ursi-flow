"""Private stdio fixture for live-observation.mjs; run only on a trusted Linux host."""
import contextlib
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'observer/tests'))
from docker_acceptance import BASE, BIN, ENV, IMAGE, Trial, docker, get, wait


class BrowserTrial(Trial):
    def launch(self, service, options, ready):
        # Already privileged. Never pass credentials to `sudo env KEY=...` in argv.
        log = self.root / f'{service}.log'
        with log.open('wb') as out:
            child = subprocess.Popen([BIN / f'ursi-{service}'], env={**ENV, **options},
                                     cwd=self.root, start_new_session=True,
                                     stdin=subprocess.DEVNULL, stdout=out, stderr=out)
        self.children[service] = child

        def check():
            assert child.poll() is None, f'{service} exited'
            return ready(log)
        wait(check, bool, f'{service} readiness')

    def gateway(self):
        def ready(log):
            match = re.search(r'^ursi-gateway listening on 127\.0\.0\.1:(\d+)$',
                              log.read_text(), re.MULTILINE)
            if match:
                self.port = int(match[1])
            return self.port
        self.launch('gateway', {
            'URSI_GATEWAY_DRIVER': 'docker', 'URSI_GATEWAY_BIND': '127.0.0.1:0',
            'URSI_GATEWAY_NAMESPACE': self.scope, 'URSI_GATEWAY_KEY': self.key,
            'URSI_GATEWAY_DB': str(self.root / 'gateway.sqlite'),
            'URSI_GATEWAY_OBSERVER_SOCKET': str(self.socket),
        }, ready)
        assert self.api('GET', '/api/v1/capabilities')['observer_enabled'] is True


def send(**message):
    print(json.dumps(message), file=sys.__stdout__, flush=True)


def receive():
    signal.alarm(180)  # EOF on parent exit; deadline also covers a hung browser.
    try:
        line = sys.stdin.readline(512)
        if not line:
            raise EOFError
        return line.rstrip('\n')
    finally:
        signal.alarm(0)


def exercise(t):
    key = receive()
    assert re.fullmatch('[0-9a-f]{64}', key)
    t.key = key
    t.gateway()
    t.a, t.b = [BASE + '/' + t.api('POST', BASE, 202, {'image': IMAGE})['id']
                for _ in range(2)]
    a, b = t.inspect_pair()  # scope/id labels, bridge mode, PID, three distinct netns
    assert not any(obj['HostConfig']['PortBindings'] for obj in (a, b))
    t.observer()
    sandbox = t.a.rsplit('/', 1)[1]
    send(port=t.port, sandbox=sandbox)

    run_id = receive()
    assert re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', run_id)
    run = f'{t.a}/observations/{run_id}'
    rec = t.state(run, 'running')
    assert rec['sandbox_id'] == sandbox and rec['observation_id'] == run_id
    assert rec['container'] == a['Id'] and rec['container_started_at'] == a['State']['StartedAt']
    current = t.inspect_pair()
    for before, now in zip((a, b), current):
        assert (before['Id'], before['State']['StartedAt']) == (now['Id'], now['State']['StartedAt'])
    peer = str(ipaddress.IPv4Address(current[1]['NetworkSettings']['Networks']['bridge']['IPAddress']))
    local, remote, private = [uuid4().hex for _ in range(3)]
    get(a['Id'], '127.0.0.1', local)
    get(a['Id'], peer, remote)
    get(b['Id'], '127.0.0.1', private)
    send(peer=peer)

    assert receive() == 'stopped'
    final = t.state(run, 'stopped')
    assert final['reason'] == 'requested' and final['segments'] == 1 and final['packets'] > 0
    frames = t.packets(run, final)  # validates complete SLL2 frames and byte/packet totals
    for mark in (local, remote):
        assert any(('GET /' + mark).encode() in f for f in frames)
    assert not any(private.encode() in f for f in frames)
    data = t.api('GET', f'{run}/segments/1')
    send(sha256=hashlib.sha256(data).hexdigest(), size=len(data))
    receive()  # parent keeps the fixture alive through preview and download


def interrupted(*_):
    raise SystemExit(1)


def main():
    if os.geteuid() != 0 or not __debug__:
        raise SystemExit('requires non-optimized privileged Python')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    with tempfile.TemporaryDirectory(prefix='ursi-web-observation-') as directory:
        t = BrowserTrial(Path(directory))
        docker('image', 'inspect', '--format', '{{.Id}}', IMAGE)
        assert not t.scoped('container') and not t.scoped('volume')
        print(f'Fixture scope: {t.scope}', flush=True)
        try:
            exercise(t)
        except EOFError:
            pass
        finally:
            t.cleanup()


if __name__ == '__main__':
    # stdout is private protocol, stderr has scope/cleanup only, never daemon logs.
    with contextlib.redirect_stdout(sys.stderr):
        try:
            main()
        except Exception as exc:
            import traceback
            frame = traceback.extract_tb(exc.__traceback__)[-1]
            sys.exit(f'Fixture failed: {type(exc).__name__} at {frame.name}:{frame.lineno}')
