#!/usr/bin/python3
"""Require an authenticated SSH exec and a successful session health response."""
import subprocess
import sys
import urllib.request
from supervisor import childutils

try:
    rpc = childutils.getRPCInterface({"SUPERVISOR_SERVER_URL": "unix:///run/ursi/supervisor.sock"})
    if rpc.supervisor.getProcessInfo("recovery")["statename"] != "RUNNING":
        raise ValueError("recovery controller not ready")
    subprocess.run([
        "ssh", "-F", "/dev/null", "-p", "2222", "-i", "/run/ursi/sshd/probe_ed25519",
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=/run/ursi/sshd/known_hosts", "-o", "ConnectTimeout=2",
        "agent@127.0.0.1", "true"
    ], check=True, timeout=4, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:8765/healthz", timeout=2) as response:
        if response.status != 200:
            raise ValueError("session service not ready")
except Exception:
    sys.exit(1)
