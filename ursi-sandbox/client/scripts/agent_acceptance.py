#!/usr/bin/env python3
"""真实 Pi 验收。只使用公开 Gateway/ACP、SSH/SFTP 和本 scope 的 Docker 资源。"""
import argparse
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


class AcceptanceError(RuntimeError):
    def __init__(self, message, *, command=None, exit_code=None):
        super().__init__(message)
        self.command = command
        self.exit_code = exit_code


def command_category(args):
    # 只接受固定命令名，不把路径、会话、提示词或配置写入诊断。
    if args and args[0] in ("ssh", "sftp-put", "sftp-get"):
        return args[0]
    allowed = {"acp": {"initialize", "new", "prompt", "status", "cancel", "close"},
               "gateway": {"capabilities", "create", "list", "status", "endpoints", "stop", "start", "delete"}}
    if len(args) >= 2 and args[1] in allowed.get(args[0], set()):
        return args[0] + " " + args[1]
    return "unknown"


def process_check_script(pids, supervisor_pid, marker, *, alive):
    # /proc 的 stat/cmdline 对跨 UID 监督器可读，kill(0) 则会返回 EPERM。
    code = f"""from pathlib import Path
proc = Path('/proc')
pids = {pids!r}
supervisor_pid = {supervisor_pid!r}
marker = {marker!r}.encode()
"""
    if alive:
        code += """for pid in pids:
    entry = proc / str(pid)
    state = (entry / 'stat').read_text().rsplit(')', 1)[1].split()[0]
    assert state not in ('Z', 'X', 'x'), 'tracked process is not live'
    args = (entry / 'cmdline').read_bytes().split(b'\\0')
    if pid == supervisor_pid:
        assert b'--ursi-pi-supervisor' in args, 'supervisor identity mismatch'
        uid = next(line.split()[1] for line in (entry / 'status').read_text().splitlines()
                   if line.startswith('Uid:'))
        assert uid == '0', 'supervisor must be root-owned'
    else:
        assert marker in args, 'tool identity mismatch'
"""
    else:
        code += """assert all(not (proc / str(pid)).exists() for pid in pids), 'tracked PID remains'
for entry in proc.iterdir():
    if not entry.name.isdigit(): continue
    try:
        command = (entry / 'cmdline').read_bytes()
    except (FileNotFoundError, ProcessLookupError):
        continue
    assert marker not in command, 'marked descendant remains'
"""
    return "python3 - <<'PY'\n" + code + "PY\n"


def require(condition, message):
    if not condition:
        raise AcceptanceError(message)


def run(argv, *, env=None, timeout=30, check=True):
    # 不输出 argv、环境或 stderr，其中可能含模型配置。
    result = subprocess.run([str(a) for a in argv], env=env, capture_output=True,
                            text=True, timeout=timeout)
    if check and result.returncode:
        raise AcceptanceError("子进程执行失败")
    return result


def wait_until(check, seconds, description):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.2)
    raise AcceptanceError(description + " 超时")


def sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def private_write(path, text):
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)
    return path


class BundleServer(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/bundle.tar.gz":
            self.send_error(404)
            return
        super().do_GET()

    def log_message(self, *args):
        pass


class Acceptance:
    def __init__(self, args, temporary):
        self.args = args
        self.root = Path(temporary)
        self.scope = "ursi-agent-" + secrets.token_hex(10)
        # 只保留安全结构化证据。原始模型/SSH/Gateway 输出仅存在临时目录。
        self.report = {"scope": self.scope, "real_model": True, "passed": False,
                       "checks": [], "updates": {}, "cleanup": False}
        self.env = os.environ.copy()
        for name in ("URSI_GATEWAY_KEY", "URSI_GATEWAY_KEY_FILE", "URSI_SESSION_TOKEN",
                     "URSI_SESSION_TOKEN_FILE", "URSI_GATEWAY_RUNTIME_PROFILES"):
            self.env.pop(name, None)
        self.gateway = None
        self.server = None
        self.prompts = []
        self.sandbox = None
        self.gateway_url = None
        self.stage = "prepare"
        self.substage = None
        self.evidence = getattr(args, "evidence", None)
        self.save_evidence()

    def save_evidence(self):
        if self.evidence:
            private_write(self.evidence, json.dumps(self.report, ensure_ascii=False, indent=2) + "\n")

    def failure_details(self, error):
        details = {"stage": self.stage, "substage": self.substage, "kind": type(error).__name__}
        if isinstance(error, AcceptanceError):
            details.update(summary=str(error), command=error.command, exit_code=error.exit_code)
        return details

    def record(self, name, **facts):
        self.report["checks"].append({"check": name, **facts})
        self.save_evidence()
        print(name, flush=True)

    def cli(self, *args, timeout=None, check=True):
        timeout = timeout or self.args.operation_timeout
        env = self.env.copy()
        env["URSI_CLIENT_TIMEOUT_SECS"] = str(max(1, int(timeout)))
        category = command_category(args)
        try:
            result = run([self.args.client, *args], env=env, timeout=timeout + 5, check=False)
        except subprocess.TimeoutExpired:
            raise AcceptanceError("客户端操作超时", command=category) from None
        except OSError:
            raise AcceptanceError("客户端启动失败", command=category) from None
        if check and result.returncode != 0:
            raise AcceptanceError("客户端操作失败", command=category, exit_code=result.returncode)
        try:
            values = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        except json.JSONDecodeError:
            raise AcceptanceError("客户端 JSON 输出无效", command=category,
                                  exit_code=result.returncode) from None
        for value in values:
            self.observe(value)
        results = [value["result"] for value in values if value.get("type") == "result"]
        return result.returncode, results[-1] if results else None

    def observe(self, value):
        if value.get("type") == "update":
            update = value.get("params", {}).get("update", {})
            kind = update.get("sessionUpdate")
            if kind in ("agent_message_chunk", "tool_call", "tool_call_update"):
                self.report["updates"][kind] = self.report["updates"].get(kind, 0) + 1

    def gateway_call(self, command, *args):
        return self.cli("gateway", command, *args)[1]

    def status(self):
        return self.gateway_call("status", self.sandbox)

    def state(self, expected):
        def check():
            status = self.status()
            require(status["status"] != "error", "Gateway 沙箱进入 error")
            return status if status["status"] == expected and status.get("operation") is None else None
        return wait_until(check, self.args.lifecycle_timeout, "等待沙箱 " + expected)

    def ssh(self, script, check=True):
        path = private_write(self.root / "command.sh", script)
        return self.cli("ssh", self.host, str(self.port), self.identity, self.known_hosts,
                        path, check=check)

    def acp(self, command, *args):
        return self.cli("acp", command, *args)[1]

    def prompt(self, session, text):
        path = private_write(self.root / "prompt.txt", text)
        _, value = self.cli("acp", "prompt", session, path, timeout=self.args.prompt_timeout)
        require(value.get("stopReason") == "end_turn", "真实 prompt 没有 end_turn")
        return value

    def prepare(self):
        config = self.root / "config"
        (config / "pi").mkdir(parents=True, mode=0o700)
        config.chmod(0o700)
        # 只复制契约列出的必要文件，不读取 host 全量 Pi auth/配置。
        for relative in ("pi/models.json", "session.json", "pi/auth.json"):
            source = self.args.config_dir / relative
            if relative == "pi/auth.json" and not source.exists():
                continue
            value = json.loads(source.read_text(encoding="utf-8"))
            private_write(config / relative, json.dumps(value))
        if self.args.ssh_key:
            self.identity = self.args.ssh_key.resolve()
            require(self.identity.is_file(), "SSH 私钥不存在")
            authorized = (self.args.config_dir / "authorized_keys").read_text(encoding="utf-8")
            public = run(["ssh-keygen", "-y", "-P", "", "-f", self.identity]).stdout.strip()
            require(" ".join(public.split()[:2]) in authorized, "提供的 SSH key 不在 authorized_keys")
            private_write(config / "authorized_keys", authorized)
        else:
            self.identity = self.root / "id_ed25519"
            run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", self.identity])
            private_write(config / "authorized_keys", self.identity.with_suffix(".pub").read_text())
        supplied_token = self.args.config_dir / "session-token"
        token = supplied_token.read_text(encoding="utf-8").strip() if supplied_token.exists() else secrets.token_urlsafe(40)
        require(len(token) >= 32 and not any(c.isspace() for c in token), "session-token 无效")
        self.env["URSI_SESSION_TOKEN_FILE"] = str(private_write(config / "session-token", token))
        self.known_hosts = private_write(self.root / "known_hosts", "")
        # Gateway 用 env 接收 key。客户端只读取文件，避免身份出现在 argv。
        self.gateway_key = secrets.token_urlsafe(40)
        self.env["URSI_GATEWAY_KEY_FILE"] = str(private_write(self.root / "gateway-key", self.gateway_key))
        profiles = private_write(self.root / "profiles.json", json.dumps({"pi": {"config_dir": str(config)}}))
        publish = self.root / "publish"
        publish.mkdir(mode=0o700)
        (publish / "bundle.tar.gz").symlink_to(self.args.bundle.resolve())
        handler = functools.partial(BundleServer, directory=str(publish))
        self.server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        host = self.args.bundle_host
        if not host:
            bridge = json.loads(run(["docker", "network", "inspect", "bridge"]).stdout)
            gateways = [item.get("Gateway") for item in bridge[0]["IPAM"]["Config"] if item.get("Gateway")]
            require(gateways, "无法推导 bridge 网关，请显式设置 --bundle-host")
            host = gateways[0]
        # 探测结果是候选地址，真实下载由 Runtime 启动证明。支持操作方覆盖。
        require(not any(c in host for c in "/@?# \r\n"), "bundle host 无效")
        host_url = f"[{host}]" if ":" in host and not host.startswith("[") else host
        self.bundle_url = f"http://{host_url}:{self.server.server_port}/bundle.tar.gz"
        gateway_env = self.env.copy()
        gateway_env.update(URSI_GATEWAY_KEY=self.gateway_key, URSI_GATEWAY_DRIVER="docker",
                           URSI_GATEWAY_NAMESPACE=self.scope, URSI_GATEWAY_DB=str(self.root / "gateway.sqlite"),
                           URSI_GATEWAY_BIND="0.0.0.0:0", URSI_GATEWAY_PUBLIC_BIND="0.0.0.0",
                           URSI_GATEWAY_ADVERTISE_HOST="127.0.0.1", URSI_GATEWAY_TUNNEL="false",
                           URSI_GATEWAY_RUNTIME_PROFILES=str(profiles))
        log = self.root / "gateway.log"
        with log.open("w", encoding="utf-8") as output:
            self.gateway = subprocess.Popen([str(self.args.gateway)], env=gateway_env, stdout=output,
                                            stderr=subprocess.STDOUT, start_new_session=True)
        def address():
            require(self.gateway.poll() is None, "Gateway 启动失败")
            match = re.search(r"listening on 0\.0\.0\.0:(\d+)", log.read_text(encoding="utf-8"))
            return int(match.group(1)) if match else None
        port = wait_until(address, 30, "等待 Gateway 监听")
        self.gateway_url = f"http://127.0.0.1:{port}"
        self.env["URSI_GATEWAY_URL"] = self.gateway_url
        self.gateway_call("capabilities")
        self.record("独立 Gateway 与 bundle HTTP 已启动", gateway_port=port,
                    bundle_sha256=sha(self.args.bundle), image=self.args.image)

    def connect_endpoints(self, sandbox):
        endpoints = {item["name"]: item for item in sandbox["endpoints"]}
        require(endpoints["ssh"]["visibility"] == "public", "SSH 应为 public")
        require(endpoints["session"]["visibility"] == "internal", "session 应为 internal")
        self.host, port = endpoints["ssh"]["address"].rsplit(":", 1)
        self.host = self.host.strip("[]")
        self.port = int(port)
        self.env["URSI_ACP_URL"] = "ws://" + endpoints["session"]["address"] + "/acp"

    def create(self):
        self.stage = "create"
        spec = {"image": self.args.image, "runtime_profile": "pi", "ports": [
            {"name": "ssh", "port": 2222, "visibility": "public", "ready": True},
            {"name": "session", "port": 8765, "visibility": "internal", "ready": True}],
            "memory_mb": 2048, "cpus": 2.0, "labels": {"acceptance": self.scope},
            "bundle": {"url": self.bundle_url, "sha256": sha(self.args.bundle), "min_image_level": 1}}
        path = private_write(self.root / "spec.json", json.dumps(spec))
        self.sandbox = self.gateway_call("create", path)["id"]
        self.connect_endpoints(self.state("running"))
        self.record("正式 Runtime 就绪", sandbox=self.sandbox)

    def repository(self):
        self.stage = "repository"
        _, output = self.ssh("test \"$(id -un)\" = agent\ntest \"$(id -u)\" != 0\nmkdir -p /ursi/workspace/repo\n")
        require(output["success"], "SSH agent 验证失败")
        fixtures = {
            "calculator.py": "def add(a, b):\n    return a - b\n",
            "test_calculator.py": "import unittest\nfrom calculator import add\n\nclass CalculatorTests(unittest.TestCase):\n    def test_zero(self):\n        self.assertEqual(add(0, 0), 0)\n\nif __name__ == '__main__':\n    unittest.main()\n",
            ".gitignore": "__pycache__/\n",
        }
        for name, content in fixtures.items():
            local = private_write(self.root / name, content)
            self.cli("sftp-put", self.host, str(self.port), self.identity, self.known_hosts,
                     local, "/ursi/workspace/repo/" + name)
        self.ssh("cd /ursi/workspace/repo\ngit init -q\ngit config user.name Acceptance\ngit config user.email acceptance@localhost\ngit add .\ngit commit -qm baseline\npython3 -m unittest -v\n")
        self.record("通过 SSH agent 与 SFTP 准备 Git 仓库")

    def repair(self):
        self.stage = "repair"
        self.session = self.acp("new", "/ursi/workspace/repo")["sessionId"]
        self.prompt(self.session, "Fix calculator.py: add(a,b) must return the mathematical sum. Add meaningful positive and negative number regression tests to test_calculator.py. Run python3 -m unittest -v. Do not commit or change unrelated files. Complete the task with the actual file edits.")
        # 使用独立 SSH 读取差异及运行固定断言，不能用模型消息代替。
        _, output = self.ssh("cd /ursi/workspace/repo\ngit diff --exit-code --quiet && exit 42\ngit diff --check\ngit diff --numstat\npython3 -m unittest -v\npython3 - <<'PY'\nfrom calculator import add\nassert add(7, 5) == 12\nassert add(-9, 4) == -5\nassert add(-3, -8) == -11\nimport unittest\nsuite = unittest.defaultTestLoader.discover('.', pattern='test_calculator.py')\nassert suite.countTestCases() >= 2, 'Pi must add a regression test'\n# 独立注入原 bug，新增测试必须能检测到回归。\nimport calculator\ncalculator.add = lambda a, b: a - b\nimport sys\nsys.modules.pop('test_calculator', None)\nsuite = unittest.defaultTestLoader.discover('.', pattern='test_calculator.py')\nresult = unittest.TextTestRunner().run(suite)\nassert not result.wasSuccessful(), 'new tests do not detect the original bug'\nPY\n")
        require(output["success"], "独立回归测试失败")
        _, diff_output = self.ssh("cd /ursi/workspace/repo\ngit diff -- calculator.py test_calculator.py\n")
        diff = diff_output["stdout"]
        require("diff --git a/calculator.py" in diff and "diff --git a/test_calculator.py" in diff, "函数和测试都必须修改")
        # SFTP 拉回实际文件，独立内容摘要用于 stop/start 持久性核对。
        self.before = {}
        for name in ("calculator.py", "test_calculator.py"):
            path = self.root / ("verified-" + name)
            self.cli("sftp-get", self.host, str(self.port), self.identity, self.known_hosts,
                     path, "/ursi/workspace/repo/" + name)
            self.before[name] = sha(path)
        self.record("真实 Pi end_turn 后独立验证函数、补测和 Git 差异", files=self.before,
                    diff_sha256=hashlib.sha256(diff.encode()).hexdigest(),
                    verification_stdout_sha256=hashlib.sha256(output["stdout"].encode()).hexdigest(),
                    independent_assertions_passed=True, original_bug_detected_by_added_tests=True)

    def cancellation(self):
        self.stage = "cancel"
        self.substage = "second_session_create"
        second = self.acp("new", "/ursi/workspace/repo")["sessionId"]
        marker = "ursi_sleep_" + secrets.token_hex(12)
        # 工具脚本在 repo 外，使用唯一参数识别父子进程。PID 文件由工具写入。
        helper = "/ursi/workspace/" + marker + ".py"
        pidfile = "/ursi/workspace/" + marker + ".json"
        code = ("import json, os, subprocess, sys, time\n"
                "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)', sys.argv[1]])\n"
                "with open(sys.argv[2] + '.tmp', 'w') as f: json.dump([os.getpid(), child.pid], f)\n"
                "os.replace(sys.argv[2] + '.tmp', sys.argv[2])\n"
                "time.sleep(600)\n")
        self.substage = "tool_upload"
        local = private_write(self.root / "sleep.py", code)
        self.cli("sftp-put", self.host, str(self.port), self.identity, self.known_hosts, local, helper)
        prompt = private_write(self.root / "sleep-prompt.txt", f"Use the bash tool now to run exactly: python3 {helper} {marker} {pidfile}\nRun it in the foreground and wait for it. Do not read files, background it, set a short timeout, or terminate it. This is an operator cancellation test.")
        events = self.root / "cancel-events.jsonl"
        errors = self.root / "cancel-errors.txt"
        env = self.env.copy()
        env["URSI_CLIENT_TIMEOUT_SECS"] = str(self.args.prompt_timeout)
        self.substage = "prompt_start"
        try:
            with events.open("w", encoding="utf-8") as out, errors.open("w", encoding="utf-8") as err:
                process = subprocess.Popen([str(self.args.client), "acp", "prompt", self.session, str(prompt)],
                                           env=env, stdout=out, stderr=err, start_new_session=True)
        except OSError:
            raise AcceptanceError("长任务客户端启动失败", command="acp prompt") from None
        self.prompts.append(process)
        observed_lines = 0
        tool_started = False
        def running_tool():
            nonlocal observed_lines, tool_started
            exit_code = process.poll()
            if exit_code is not None:
                raise AcceptanceError("长任务提前结束", command="acp prompt", exit_code=exit_code)
            lines = events.read_text(encoding="utf-8").splitlines()
            for line in lines[observed_lines:]:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    break  # 末尾可能还未写完。
                observed_lines += 1
                self.observe(value)
                update = value.get("params", {}).get("update", {})
                if update.get("sessionUpdate") in ("tool_call", "tool_call_update") and update.get("status") == "in_progress":
                    tool_started = True
            if not tool_started:
                return False
            code, output = self.ssh(f"test -s {pidfile}\n", check=False)
            if code != 0 and not (code == 1 and output and output.get("code") == 1):
                raise AcceptanceError("等待工具 PID 时 SSH 失败", command="ssh", exit_code=code)
            return code == 0 and output and output["success"]
        self.substage = "tool_start_wait"
        wait_until(running_tool, self.args.prompt_timeout, "等待真实工具开始与子进程 PID")
        self.substage = "tool_pid_read"
        _, output = self.ssh(f"cat {pidfile}\n")
        pids = json.loads(output["stdout"])
        require(isinstance(pids, list) and len(pids) == 2
                and all(type(pid) is int and pid > 1 for pid in pids)
                and len(set(pids)) == 2, "工具 PID 证据无效")
        self.substage = "running_status"
        running = self.acp("status", self.session)
        cli_pid = running.get("pid")
        require(running["state"] == "running" and type(cli_pid) is int and cli_pid > 1
                and cli_pid not in pids, "长任务缺少独立运行中的监督器 PID")
        tracked_pids = [*pids, cli_pid]
        self.substage = "process_identity_before_cancel"
        self.ssh(process_check_script(tracked_pids, cli_pid, marker, alive=True))
        self.substage = "cancel_send"
        self.acp("cancel", self.session)
        self.substage = "prompt_cancelled_wait"
        try:
            exit_code = process.wait(timeout=self.args.operation_timeout)
        except subprocess.TimeoutExpired:
            raise AcceptanceError("等待原 prompt 取消超时", command="acp prompt") from None
        if exit_code != 2:
            raise AcceptanceError("原 prompt 必须返回 cancelled/退出码2", command="acp prompt",
                                  exit_code=exit_code)
        values = [json.loads(line) for line in events.read_text(encoding="utf-8").splitlines()]
        require(any(v.get("type") == "result" and v.get("result", {}).get("stopReason") == "cancelled" for v in values), "缺少 cancelled 响应")
        self.substage = "cancelled_status"
        status = self.acp("status", self.session)
        require(status["state"] == "cancelled" and "pid" in status and status["pid"] is None, "取消状态或 CLI PID 未清理")
        # cancelled 是清理完成的承诺，收到后立即检查，不以稍后杀进程掩盖失败。
        self.substage = "processes_gone_after_cancel"
        self.ssh(process_check_script(tracked_pids, cli_pid, marker, alive=False))
        self.substage = "second_session_prompt"
        self.prompt(second, "Without changing files, use bash to run python3 -m unittest -v in this repository, then report completion.")
        self.substage = "second_session_verify"
        self.ssh("cd /ursi/workspace/repo\npython3 -m unittest -v\n")
        self.substage = "first_session_close"
        self.acp("close", self.session)
        self.substage = "second_session_close"
        self.acp("close", second)
        self.record("真实长工具取消后 CLI 与父子进程退出，另一会话继续成功", child_pids=pids,
                    cli_pid=cli_pid, cancelled_state=status["state"], second_session_completed=True)
        self.substage = None

    def persistence(self):
        self.stage = "persistence"
        self.gateway_call("stop", self.sandbox)
        self.state("stopped")
        self.gateway_call("start", self.sandbox)
        self.connect_endpoints(self.state("running"))
        # 同一资源重启仍使用原 known_hosts，不能通过清空文件绕过主机密钥校验。
        for name, expected in self.before.items():
            local = self.root / ("restarted-" + name)
            self.cli("sftp-get", self.host, str(self.port), self.identity, self.known_hosts,
                     local, "/ursi/workspace/repo/" + name)
            require(sha(local) == expected, "停止再启动后仓库内容改变")
        self.ssh("cd /ursi/workspace/repo\npython3 -m unittest -v\ngit diff --check\n")
        self.record("停止再启动后仓库与补测保留")

    def owned(self, volumes=False):
        command = ["docker", "volume", "ls", "-q"] if volumes else ["docker", "ps", "-aq"]
        return run([*command, "--filter", "label=io.ursi.scope=" + self.scope]).stdout.split()

    def gone(self):
        request = urllib.request.Request(self.gateway_url + "/api/v1/sandboxes/" + self.sandbox,
                                         headers={"Authorization": "Bearer " + self.gateway_key})
        try:
            with urllib.request.urlopen(request, timeout=5):
                return False
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return True
            raise AcceptanceError("删除状态查询失败") from None

    def delete(self):
        self.stage = "delete"
        self.gateway_call("delete", self.sandbox)
        wait_until(self.gone, self.args.lifecycle_timeout, "等待删除 404")
        require(not self.owned() and not self.owned(True), "Gateway 删除后仍有所属容器或卷")
        self.record("Gateway 删除完成且 scope 下无容器和卷")
        self.report["passed"] = True

    def cleanup(self):
        # 先停止调用方，再请求 Gateway 删除，最后停 Gateway 防止对账重建。
        for process in self.prompts:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
        if self.sandbox and self.gateway and self.gateway.poll() is None and not self.report["passed"]:
            try:
                self.gateway_call("delete", self.sandbox)
                wait_until(self.gone, min(30, self.args.lifecycle_timeout), "失败清理")
            except Exception:
                pass
        if self.gateway and self.gateway.poll() is None:
            os.killpg(self.gateway.pid, signal.SIGTERM)
            try:
                self.gateway.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.gateway.pid, signal.SIGKILL)
                self.gateway.wait(timeout=3)
        # 只操作本次随机 scope，不运行 prune，不按容器名称猜归属。
        for volumes in (False, True):
            for resource in self.owned(volumes):
                inspect = ["docker", "volume", "inspect"] if volumes else ["docker", "inspect"]
                info = json.loads(run([*inspect, resource]).stdout)[0]
                labels = info.get("Labels", {}) if volumes else info.get("Config", {}).get("Labels", {})
                require(labels.get("io.ursi.scope") == self.scope, "资源归属变化，拒绝删除")
                command = ["docker", "volume", "rm", resource] if volumes else ["docker", "rm", "-f", resource]
                run(command)
        self.report["cleanup"] = not self.owned() and not self.owned(True)
        if self.server:
            self.server.shutdown()
            self.server.server_close()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway", required=True, type=Path, help="集成后的正式 ursi-gateway binary")
    parser.add_argument("--client", required=True, type=Path, help="ursi-sandbox-client binary")
    parser.add_argument("--bundle", required=True, type=Path, help="正式 runtime bundle tar.gz")
    parser.add_argument("--config-dir", required=True, type=Path, help="操作方提供的最小配置目录")
    parser.add_argument("--ssh-key", type=Path, help="与配置 authorized_keys 对应的无口令私钥。省略则生成临时 key")
    parser.add_argument("--image", default="ursi-runtime-pi:local")
    parser.add_argument("--bundle-host", help="容器可访问的宿主地址。默认探测 Docker bridge 网关")
    parser.add_argument("--evidence", type=Path, help="脱敏 JSON 证据路径，必须在仓库外。默认系统临时目录")
    parser.add_argument("--operation-timeout", type=int, default=60)
    parser.add_argument("--lifecycle-timeout", type=int, default=240)
    parser.add_argument("--prompt-timeout", type=int, default=300)
    args = parser.parse_args()
    for name in ("gateway", "client", "bundle", "config_dir"):
        setattr(args, name, getattr(args, name).resolve())
    require(all(1 <= value <= 3600 for value in (args.operation_timeout, args.lifecycle_timeout, args.prompt_timeout)), "期限必须在1..3600秒")
    return args


def main():
    args = parse_args()
    require(os.environ.get("URSI_AGENT_ACCEPTANCE") == "1", "真实验收需要显式 URSI_AGENT_ACCEPTANCE=1")
    require(sys.platform.startswith("linux"), "当前真实验收需要 Linux 本机 Docker、SSH 与容器 IP 可达")
    require(os.geteuid() == 0, "真实验收需要通过 sudo 以 root 运行，Runtime 配置目录必须 root 所有且权限为 0700")
    for program in ("docker", "ssh", "sftp", "ssh-keygen"):
        require(shutil.which(program), "缺少依赖工具 " + program)
    for binary in (args.gateway, args.client):
        require(binary.is_file() and os.access(binary, os.X_OK), "binary 不存在或不可执行")
    require(args.bundle.is_file(), "bundle 不存在")
    repo = Path(__file__).resolve().parents[3]
    evidence = args.evidence.resolve() if args.evidence else Path("/tmp") / ("ursi-agent-evidence-" + secrets.token_hex(10) + ".json")
    require(not evidence.is_relative_to(repo), "证据不能写入仓库")
    require(evidence.parent.is_dir() and os.access(evidence.parent, os.W_OK), "证据目录必须存在且可写")
    os.umask(0o077)
    args.evidence = evidence
    def interrupted(signum, _frame):
        raise AcceptanceError("验收收到中断信号")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    with tempfile.TemporaryDirectory(prefix="ursi-agent-private-", dir="/tmp") as temporary:
        acceptance = Acceptance(args, temporary)
        try:
            acceptance.prepare()
            acceptance.create()
            acceptance.repository()
            acceptance.repair()
            acceptance.cancellation()
            acceptance.persistence()
            acceptance.delete()
        except Exception as error:
            acceptance.report["failure"] = acceptance.failure_details(error)
            print("真实验收失败，阶段：" + acceptance.stage, file=sys.stderr)
        finally:
            # 清理阶段不被第二次普通信号打断。
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                acceptance.cleanup()
            except Exception as error:
                acceptance.report["cleanup_error"] = type(error).__name__
                acceptance.report["passed"] = False
            acceptance.report["passed"] = acceptance.report["passed"] and acceptance.report["cleanup"]
            acceptance.save_evidence()
            print("脱敏证据：" + str(evidence))
        return 0 if acceptance.report["passed"] and acceptance.report["cleanup"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AcceptanceError, OSError, ValueError) as error:
        # 入口校验错误仅含脚本自定义安全摘要。
        summary = str(error) if isinstance(error, AcceptanceError) else type(error).__name__
        print("验收输入/环境校验失败：" + summary, file=sys.stderr)
        sys.exit(1)
