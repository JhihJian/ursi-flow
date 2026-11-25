#!/usr/bin/python3
"""Check the common supervisor and authenticated SSH exec."""
import subprocess
import sys
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
except Exception:
    sys.exit(1)
