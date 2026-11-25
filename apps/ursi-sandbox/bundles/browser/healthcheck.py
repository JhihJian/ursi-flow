#!/usr/bin/python3
import socket
import subprocess

subprocess.run(["/ursi/healthcheck-pi"], check=True)
for port in (8744, 9222, 6080):
    with socket.create_connection(("127.0.0.1", port), timeout=2):
        pass
