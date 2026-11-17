#!/usr/bin/env python3
"""Build a deterministic bundle. Its input is an already-built service binary."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile


def main():
    binary, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise SystemExit("session-service binary must be an executable file")
    output.mkdir(parents=True, exist_ok=True)
    runtime = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix=".bundle-", dir=output) as temporary:
        stage = Path(temporary)
        payload = stage / "payload"
        for path, source in {
            "bin/ursi-session-service": binary,
            "supervisor/supervisord.conf": runtime / "bundle/process-supervisor/supervisord.conf",
            "supervisor/recovery.py": runtime / "bundle/process-supervisor/recovery.py",
        }.items():
            target = payload / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o755 if path.startswith("bin/") else 0o644)
        files = {str(path.relative_to(payload)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in sorted(payload.rglob("*")) if path.is_file()}
        version = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
        manifest = {"version": version, "min_image_level": 1, "profile": "pi-execution",
                    "files": files, "services": ["sshd", "session-service"],
                    "readiness": {"ssh": "authenticated exec", "session": "GET /healthz"}}
        (payload / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        archive = stage / "runtime-bundle.tar.gz"
        with archive.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                for path in sorted(payload.rglob("*")):
                    info = tar.gettarinfo(str(path), str(path.relative_to(payload)))
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = "root"
                    info.mode = 0o755 if path.is_dir() or str(path.relative_to(payload)).startswith("bin/") else 0o644
                    if path.is_file():
                        with path.open("rb") as data:
                            tar.addfile(info, data)
                    else:
                        tar.addfile(info)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.replace(output / archive.name)
        (output / "runtime-bundle.sha256").write_text(digest + "  runtime-bundle.tar.gz\n", encoding="utf-8")
        print(digest)


if __name__ == "__main__":
    main()
