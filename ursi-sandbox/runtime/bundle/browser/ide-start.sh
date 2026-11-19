#!/bin/bash
set -euo pipefail
exec code-server --bind-addr 0.0.0.0:8744 --auth none --disable-telemetry /ursi/workspace
