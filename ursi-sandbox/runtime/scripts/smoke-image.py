#!/usr/bin/env python3
"""Real SSH/image smoke with a clearly labelled health-only session fixture.

This does not exercise ACP or a model and cannot certify agent acceptance.
All Docker resources belong to a random scope and are removed in finally.
"""
import functools
import http.server
import json
import os
from pathlib import Path
import secrets
import signal
import shutil
import subprocess
import tempfile
import threading
import time

IMAGE = os.environ.get("URSI_TEST_IMAGE", "ursi-runtime-pi:local")
RUNTIME = Path(__file__).resolve().parents[1]
CAPS = ["--cap-drop=ALL", "--security-opt=no-new-privileges"]
for cap in ("CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "SYS_CHROOT", "KILL"):
    CAPS += ["--cap-add=" + cap]


def run(*args, check=True, **kwargs):
    kwargs.setdefault("timeout", 40)
    return subprocess.run(args, check=check, text=True, capture_output=True, **kwargs)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def wait_for(predicate, seconds=45):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.5)
    raise AssertionError("timed out waiting for runtime state")


def smoke(scope, temporary):
    config, output = temporary / "config", temporary / "bundle"
    config.mkdir(mode=0o700)
    (config / "pi").mkdir()
    (config / "session-token").write_text(secrets.token_hex(32))
    (config / "session.json").write_text('{"provider":"fixture","model":"fixture"}')
    (config / "pi/models.json").write_text('{}')
    key = temporary / "key"
    run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key))
    shutil.copyfile(str(key) + ".pub", config / "authorized_keys")
    fixture = temporary / "session-fixture"
    fixture.write_text('''#!/usr/bin/python3
# Health-only fixture: never an ACP or agent implementation.
from http.server import BaseHTTPRequestHandler, HTTPServer
import signal
# Exercise Supervisor's bounded stop fallback with an uncooperative service.
signal.signal(signal.SIGTERM, signal.SIG_IGN)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/healthz" else 404)
        self.end_headers()
        self.wfile.write(b'{"fixture":true}')
    def log_message(self, *_): pass
HTTPServer(("0.0.0.0", 8765), Handler).serve_forever()
''')
    fixture.chmod(0o755)
    run(str(RUNTIME / "scripts/build-bundle.sh"), str(fixture), str(output))
    digest = (output / "runtime-bundle.sha256").read_text().split()[0]
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), functools.partial(QuietHandler, directory=str(output)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    bundle_url = f"http://host.docker.internal:{server.server_port}/runtime-bundle.tar.gz"
    volume = scope + "-workspace"

    def helper(code):
        return run("docker", "run", "--rm", "--name", scope + "-helper", *CAPS,
                   "--mount", f"type=bind,src={temporary},dst=/fixture", "--entrypoint", "python3", IMAGE, "-c", code)

    def exec_in(*command, check=True):
        return run("docker", "exec", scope, *command, check=check)

    def healthy():
        return exec_in("/ursi/healthcheck", check=False).returncode == 0

    def service_pid():
        result = exec_in("sh", "-c", 'supervisorctl -s unix:///run/ursi/supervisor.sock pid session-service', check=False)
        return result.stdout.strip()

    try:
        helper('import os; from pathlib import Path; p=Path("/fixture/config"); '
               '[(os.chown(x,0,0), x.chmod(0o700 if x.is_dir() else 0o600)) for x in [p,*p.rglob("*")]]')
        def reject(expected, readonly=True, env=()):
            mount = f"type=bind,src={config},dst=/run/ursi/config" + (",readonly" if readonly else "")
            result = run("docker", "run", "--rm", "--name", scope + "-reject", *CAPS,
                         "--mount", mount, *env, IMAGE, check=False)
            assert result.returncode != 0 and expected in result.stderr, result.stderr
        reject("mounted read-only", readonly=False)
        helper('from pathlib import Path; Path("/fixture/config").chmod(0o755)')
        reject("root-owned mode 0700")
        helper('import os; from pathlib import Path; Path("/fixture/config").chmod(0o700); os.chown("/fixture/config",1000,1000)')
        reject("root-owned mode 0700")
        helper('import os; from pathlib import Path; os.chown("/fixture/config",0,0); Path("/fixture/config/session-token").write_text("short")')
        reject("at least 32")
        helper('import secrets; from pathlib import Path; Path("/fixture/config/session-token").write_text(secrets.token_hex(32))')
        helper('from pathlib import Path; Path("/fixture/config/authorized_keys").write_text("invalid-key")')
        reject("no valid SSH public key")
        helper('import shutil; shutil.copyfile("/fixture/key.pub", "/fixture/config/authorized_keys")')
        reject("requires image level", env=("-e", "URSI_BUNDLE_MIN_IMAGE_LEVEL=2"))
        print("PASS unsafe configuration and image-level rejection", flush=True)
        run("docker", "volume", "create", "--label", "io.ursi.test-scope=" + scope, volume)
        run("docker", "run", "-d", "--name", scope, "--label", "io.ursi.test-scope=" + scope, *CAPS,
            "--cpus=1", "--memory=768m", "--pids-limit=128", "--add-host=host.docker.internal:host-gateway",
            "--mount", f"type=bind,src={config},dst=/run/ursi/config,readonly",
            "--mount", f"type=volume,src={volume},dst=/ursi/workspace",
            "-e", "URSI_BUNDLE_URL=" + bundle_url, "-e", "URSI_BUNDLE_SHA256=" + digest,
            "-e", "URSI_BUNDLE_MIN_IMAGE_LEVEL=1", "-e", "no_proxy=host.docker.internal,localhost,127.0.0.1",
            "-e", "NO_PROXY=host.docker.internal,localhost,127.0.0.1", "-p", "0.0.0.0::2222", IMAGE)
        wait_for(healthy)
        port = json.loads(run("docker", "inspect", scope).stdout)[0]["NetworkSettings"]["Ports"]["2222/tcp"][0]["HostPort"]
        ssh = ["ssh", "-F", "/dev/null", "-p", port, "-i", str(key), "-o", "IdentitiesOnly=yes",
               "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o",
               "UserKnownHostsFile=" + str(temporary / "known_hosts"), "-o", "ConnectTimeout=3"]
        result = run(*ssh, "agent@127.0.0.1", "set -e; id -u; node --version; pi --version; git --version; grep -E 'Cap(Eff|Prm|Amb)|NoNewPrivs' /proc/self/status")
        lines = result.stdout.splitlines()
        assert lines[0] == "1000" and lines[2] == "1.5.0" and lines[3].startswith("git version"), result.stdout
        node_version = tuple(map(int, lines[1].lstrip("v").split(".")))
        assert node_version >= (22, 19, 0), node_version
        assert any(line.startswith("NoNewPrivs:") and line.split()[1] == "1" for line in lines), result.stdout
        for line in result.stdout.splitlines():
            if line.startswith("Cap"):
                assert int(line.split()[1], 16) == 0, line
        print("PASS SSH exec, uid1000, Node/Pi/Git versions, zero agent capabilities", flush=True)
        result = run(*ssh, "-tt", "agent@127.0.0.1", "test -t 0 && printf pty-ok")
        assert "pty-ok" in result.stdout
        assert run(*ssh, "root@127.0.0.1", "true", check=False).returncode != 0
        run(*ssh, "agent@127.0.0.1", "test ! -r /run/ursi/config/session-token && test ! -r /ursi/workspace/.ursi-state && ! mv /ursi/workspace/.ursi-state /ursi/workspace/stolen")
        print("PASS PTY, root-login rejection, token/state protection", flush=True)
        local_file = temporary / "upload.txt"
        local_file.write_text("retained-workspace\n")
        sftp = ["sftp", "-F", "/dev/null", "-P", port, "-i", str(key), "-o", "BatchMode=yes",
                "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + str(temporary / "known_hosts"), "-b", "-", "agent@127.0.0.1"]
        run(*sftp, input=f"put {local_file} /ursi/workspace/upload.txt\nget /ursi/workspace/upload.txt {temporary / 'download.txt'}\n")
        assert (temporary / "download.txt").read_bytes() == local_file.read_bytes()
        print("PASS SFTP upload/download", flush=True)
        exec_in("sh", "-c", "printf retained-state > /ursi/workspace/.ursi-state/probe; chmod 600 /ursi/workspace/.ursi-state/probe")
        # The archive server is gone. Reusing the verified cache must still boot.
        server.shutdown()
        server.server_close()
        stop_started = time.monotonic()
        run("docker", "stop", "-t", "25", scope)
        assert time.monotonic() - stop_started < 25, "stop exceeded service shutdown budget"
        run("docker", "start", scope)
        wait_for(healthy)
        assert exec_in("cat", "/ursi/workspace/upload.txt").stdout == "retained-workspace\n"
        assert exec_in("stat", "-c", "%u:%g:%a", "/ursi/workspace/.ursi-state/probe").stdout.strip() == "0:0:600"
        assert exec_in("cat", "/ursi/workspace/.ursi-state/probe").stdout == "retained-state"
        print("PASS offline restart, workspace and root-state preservation", flush=True)
        # Every crash consumes a lifetime budget, including successful respawns.
        for attempt in range(4):
            pid = service_pid()
            assert pid.isdigit() and int(pid) > 1, pid
            exec_in("kill", "-KILL", pid)
            if attempt < 3:
                wait_for(lambda: service_pid().isdigit() and service_pid() not in (pid, "0"))
                wait_for(healthy)
            else:
                wait_for(lambda: run("docker", "inspect", "-f", "{{.State.Running}}", scope).stdout.strip() == "false")
        print("PASS bounded service restarts and exhaustion shutdown", flush=True)
        run("docker", "start", scope)
        wait_for(healthy)
        pid = service_pid()
        exec_in("kill", "-KILL", pid)
        wait_for(lambda: service_pid() == "0")
        controller = exec_in("supervisorctl", "-s", "unix:///run/ursi/supervisor.sock", "pid", "recovery").stdout.strip()
        exec_in("kill", "-KILL", controller)
        wait_for(lambda: run("docker", "inspect", "-f", "{{.State.Running}}", scope).stdout.strip() == "false")
        print("PASS killed recovery controller fails closed during backoff", flush=True)
        print("Image smoke passed. Session used a health-only fixture; real agent acceptance remains separate.", flush=True)
    except Exception:
        print(run("docker", "logs", "--tail", "80", scope, check=False).stdout, flush=True)
        print(run("docker", "logs", "--tail", "80", scope, check=False).stderr, flush=True)
        raise
    finally:
        server.shutdown()
        server.server_close()


def main():
    scope = "ursi-image-smoke-" + secrets.token_hex(5)
    temporary = Path(tempfile.mkdtemp(prefix=scope + "-"))
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        smoke(scope, temporary)
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        errors = []
        def cleanup_command(*arguments, allow_missing=False):
            try:
                result = run(*arguments, check=False)
                missing = allow_missing and any(text in result.stderr.lower() for text in
                                               ("no such container", "no such object", "no such volume"))
                if result.returncode and not missing:
                    errors.append(result.stderr or "cleanup command failed")
            except (OSError, subprocess.SubprocessError) as error:
                errors.append(str(error))
        for container in (scope, scope + "-helper", scope + "-reject"):
            cleanup_command("docker", "rm", "-f", container, allow_missing=True)
        cleanup_command("docker", "volume", "rm", scope + "-workspace", allow_missing=True)
        config = temporary / "config"
        if config.exists() and not os.access(config, os.R_OK):
            cleanup_command("docker", "run", "--rm", "--name", scope + "-cleanup", *CAPS,
                            "--mount", f"type=bind,src={temporary},dst=/fixture", "--entrypoint", "python3", IMAGE,
                            "-c", 'import shutil; shutil.rmtree("/fixture/config")')
            cleanup_command("docker", "rm", "-f", scope + "-cleanup", allow_missing=True)
        try:
            shutil.rmtree(temporary)
        except OSError as error:
            errors.append(str(error))
        if errors:
            raise RuntimeError("test cleanup failed: " + " | ".join(errors))
        print("Cleaned test scope " + scope, flush=True)


if __name__ == "__main__":
    main()
