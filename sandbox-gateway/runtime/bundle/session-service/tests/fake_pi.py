#!/usr/bin/python3
"""确定性的 RPC 替身。不会联网，也不读取主机 Pi 凭据。"""
import json
import os
import subprocess
import sys
import threading
import time

lock = threading.Lock()
configured = set()
turn = 0

def emit(value):
    with lock:
        sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
        sys.stdout.flush()

def response(command, **extra):
    emit(dict(type="response", id=command["id"], command=command["type"], success=True, **extra))

def run(command, number):
    message = command["message"]
    if message == "crash":
        os._exit(1)
    if message == "malformed":
        print("not json", flush=True)
        return
    if message == "huge":
        print("x" * (1024 * 1024 + 1), flush=True)
        return
    if message in ("hang", "flood", "detached"):
        # Bash 独立 session，另一个进程再次 setsid，覆盖仅 killpg(Pi) 会漏的情况。
        # detached 故意继承 stdout，监督器被外部杀死后不能靠 EOF 判断任务结束。
        leaf = "import os,time; open('grandchild.pid','w').write(str(os.getpid())); time.sleep(300)"
        code = "import subprocess,time; subprocess.Popen(['/usr/bin/python3','-c'," + repr(leaf) + "],start_new_session=True); time.sleep(300)"
        child = subprocess.Popen(["/usr/bin/python3", "-c", code], start_new_session=True)
        with open("tool.pid", "w") as file:
            file.write(str(child.pid))
        emit(dict(type="tool_execution_start", toolCallId="sleep", toolName="bash", args={"command":"sleep 300"}))
        if message == "flood":
            for _ in range(2000):
                emit(dict(type="message_update", assistantMessageEvent=dict(type="text_delta", delta="x" * 65536)))
        return
    if message == "error":
        emit(dict(type="message_end", message=dict(role="assistant", stopReason="error", errorMessage="MODEL_SECRET_DO_NOT_LEAK")))
        emit(dict(type="agent_settled", aborted=False))
        return
    emit(dict(type="message_update", assistantMessageEvent=dict(type="text_delta", delta="hello\u2028world\u2029turn=" + str(number))))
    emit(dict(type="tool_execution_start", toolCallId="call-1", toolName="bash", args={"command":"printf ok"}))
    emit(dict(type="tool_execution_update", toolCallId="call-1", toolName="bash", partialResult={"content":[{"type":"text","text":"part"}]}))
    emit(dict(type="tool_execution_end", toolCallId="call-1", toolName="bash", result={"content":[{"type":"text","text":"done"}]}, isError=False))
    emit(dict(type="message_end", message=dict(role="assistant", stopReason="stop")))
    emit(dict(type="agent_end", messages=[dict(role="assistant", stopReason="stop")], willRetry=False))
    if message == "delay":
        time.sleep(0.4)
    emit(dict(type="agent_settled", aborted=False))

required = ["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-approve", "--no-prompt-templates"]
assert all(arg in sys.argv for arg in required)
assert "URSI_SESSION_TOKEN" not in os.environ
assert "HOST_SECRET" not in os.environ
assert "NODE_OPTIONS" not in os.environ
assert os.geteuid() != 0
assert os.path.isfile(os.path.join(os.environ["PI_CODING_AGENT_DIR"], "models.json"))
assert not os.path.exists(os.path.join(os.environ["HOME"], "session-token"))
workspace = os.path.dirname(os.getcwd())
if os.stat(workspace).st_uid == 0:
    assert os.getuid() == 1000 and os.getgid() == 1000 and os.getgroups() == []
    try:
        os.rename(os.path.join(workspace, '.ursi-state'), os.path.join(workspace, 'stolen-state'))
        raise AssertionError('agent renamed protected state')
    except PermissionError:
        pass
    try:
        open(os.path.join(os.path.dirname(workspace), 'config', 'session-token')).read()
        raise AssertionError('agent read session token')
    except PermissionError:
        pass
with open("identity.json", "w") as file:
    json.dump({"uid":os.getuid(), "gid":os.getgid(), "home":os.environ["HOME"], "pid":os.getpid()}, file)
print("MODEL_SECRET_DO_NOT_LEAK", file=sys.stderr, flush=True)
for line in sys.stdin.buffer:
    command = json.loads(line)
    kind = command["type"]
    if kind in ("set_auto_retry", "set_auto_compaction"):
        assert command["enabled"] is False
        configured.add(kind)
        # 错误的关联 ID 不得结束当前请求。
        emit(dict(type="response", id="unrelated", command=kind, success=False))
        response(command)
    elif kind == "prompt":
        assert configured == {"set_auto_retry", "set_auto_compaction"}
        turn += 1
        with open("prompts.count", "w") as file:
            file.write(str(turn))
        response(command, data={"disposition":"started"})
        threading.Thread(target=run, args=(command, turn), daemon=True).start()
    elif kind in ("clear_queue", "abort"):
        with open("cancellation.log", "a") as file:
            file.write(kind + "\n")
        # 故意不停止工具，验证 supervisor 硬回收。
        response(command)
