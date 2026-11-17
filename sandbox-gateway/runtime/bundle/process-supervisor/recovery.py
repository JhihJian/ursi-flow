#!/usr/bin/python3
"""Supervisor owns processes; this listener only applies a bounded restart policy."""
import os
import signal
import sys
import time
from supervisor import childutils

SERVICES = {"sshd", "session-service"}
DELAYS = (5, 10, 20)


def main():
    # Bootstrap removes this marker only on a new container start. If Supervisor
    # respawns a killed controller, fail closed rather than resetting its budget.
    marker = os.open("/run/ursi/recovery.started", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(marker)
    rpc = childutils.getRPCInterface(os.environ)
    attempts = dict.fromkeys(SERVICES, 0)
    pending = {}
    while True:
        headers, payload = childutils.listener.wait()
        # Acknowledge before RPC so Supervisor's event dispatcher never blocks.
        childutils.listener.ok()
        event = headers["eventname"]
        fields = childutils.get_headers(payload.split("\n", 1)[0])
        name = fields.get("processname")
        if event == "PROCESS_STATE_FATAL" and name in SERVICES:
            print(f"service {name} could not spawn; stopping runtime", file=sys.stderr, flush=True)
            rpc.supervisor.shutdown()
            return
        if event == "PROCESS_STATE_EXITED" and name in SERVICES:
            count = attempts[name]
            if count >= len(DELAYS):
                print(f"service {name} exhausted restart budget; stopping runtime", file=sys.stderr, flush=True)
                rpc.supervisor.shutdown()
                return
            pending[name] = time.monotonic() + DELAYS[count]
            attempts[name] += 1
            print(f"service {name}: restart {count + 1}/3 after {DELAYS[count]}s", file=sys.stderr, flush=True)
        if event == "TICK_5":
            for service, deadline in list(pending.items()):
                if time.monotonic() >= deadline:
                    del pending[service]
                    rpc.supervisor.startProcess(service, False)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # A broken recovery controller must not leave an apparently healthy runtime.
        print("recovery controller failed; stopping runtime", file=sys.stderr, flush=True)
        os.kill(1, signal.SIGTERM)
        sys.exit(1)
