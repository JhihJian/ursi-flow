#!/usr/bin/env python3
"""Focused archive/cache adversarial tests, no Docker or credentials required."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bootstrap


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def archive(self, extra=None, level=1, bad_manifest=False):
        files = {"bin/ursi-session-service": b"#!/bin/sh\nexit 0\n", "supervisor/supervisord.conf": b"test",
                 "supervisor/recovery.py": b"test"}
        manifest = {"version": "test", "min_image_level": level, "profile": "ssh",
                    "files": {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}}
        if bad_manifest:
            manifest["files"]["bin/ursi-session-service"] = "0" * 64
        files["manifest.json"] = json.dumps(manifest).encode()
        archive = self.root / "input.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size, member.mode = len(data), 0o755 if name.startswith("bin/") else 0o644
                tar.addfile(member, io.BytesIO(data))
            if extra:
                tar.addfile(extra, io.BytesIO(b""))
        archive.chmod(0o600)
        return archive

    def unpack(self, archive):
        target = self.root / "tree"
        target.mkdir(exist_ok=True)
        return bootstrap.unpack(archive, target, 1)

    def test_valid_bundle(self):
        self.assertEqual(self.unpack(self.archive())["version"], "test")

    def test_paths_links_devices_and_duplicate_rejected(self):
        for name, kind in [("/tmp/escape", tarfile.REGTYPE), ("../escape", tarfile.REGTYPE),
                           ("bin/../../escape", tarfile.REGTYPE), ("bin/link", tarfile.SYMTYPE),
                           ("bin/link", tarfile.LNKTYPE), ("device", tarfile.CHRTYPE),
                           ("manifest.json", tarfile.REGTYPE), ("bin/./x", tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as directory:
                member = tarfile.TarInfo(name)
                member.type, member.linkname = kind, "../../escape"
                with self.assertRaises((ValueError, OSError)):
                    bootstrap.unpack(self.archive(member), Path(directory), 1)

    def test_missing_recovery_controller_rejected(self):
        archive = self.archive()
        target = self.root / "incomplete.tar.gz"
        with tarfile.open(archive, "r:gz") as incoming, tarfile.open(target, "w:gz") as outgoing:
            for member in incoming:
                if member.name != "supervisor/recovery.py":
                    outgoing.addfile(member, incoming.extractfile(member))
        with self.assertRaisesRegex(ValueError, "missing service"):
            self.unpack(target)

    def test_image_level_rejected(self):
        with self.assertRaisesRegex(ValueError, "requires image level"):
            self.unpack(self.archive(level=2))

    def test_content_checksum_rejected(self):
        with self.assertRaisesRegex(ValueError, "content checksum"):
            self.unpack(self.archive(bad_manifest=True))

    def test_truncated_archive_rejected(self):
        path = self.archive()
        path.write_bytes(path.read_bytes()[:30])
        with self.assertRaises((tarfile.TarError, EOFError, ValueError)):
            self.unpack(path)

    def cached(self):
        archive = self.archive()
        digest = bootstrap.sha256(archive)
        cache = self.root / "cache"
        cache.mkdir(mode=0o755)
        archive.rename(cache / (digest + ".tar.gz"))
        return digest, cache

    def test_offline_cache_and_installed_integrity(self):
        digest, cache = self.cached()
        result = bootstrap.install_bundle("", digest, 1, cache)
        self.assertEqual(bootstrap.install_bundle("", digest, 1, cache), result)
        (result / "bin/ursi-session-service").write_text("corrupted")
        with self.assertRaisesRegex(ValueError, "installed bundle cache"):
            bootstrap.install_bundle("", digest, 1, cache)

    def test_download_checksum_mismatch(self):
        from unittest.mock import patch
        import subprocess
        def download(arguments, **_kwargs):
            Path(arguments[-1]).write_bytes(b"wrong downloaded content")
            return subprocess.CompletedProcess(arguments, 0, "", "")
        with patch.object(bootstrap.subprocess, "run", download), self.assertRaisesRegex(ValueError, "bundle SHA256 mismatch"):
            bootstrap.install_bundle("http://example.invalid/bundle", "0" * 64, 1, self.root / "cache")

    def test_cached_archive_corruption(self):
        digest, cache = self.cached()
        (cache / (digest + ".tar.gz")).write_bytes(b"broken")
        with self.assertRaisesRegex(ValueError, "cached archive checksum"):
            bootstrap.install_bundle("", digest, 1, cache)

    def test_extra_file_and_symlink_cache_rejected(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink), tempfile.TemporaryDirectory() as directory:
                archive = self.archive()
                digest, cache = bootstrap.sha256(archive), Path(directory)
                (cache / (digest + ".tar.gz")).write_bytes(archive.read_bytes())
                (cache / (digest + ".tar.gz")).chmod(0o600)
                result = bootstrap.install_bundle("", digest, 1, cache)
                path = result / "extra"
                path.symlink_to("/etc/passwd") if symlink else path.write_text("extra")
                with self.assertRaises(ValueError):
                    bootstrap.install_bundle("", digest, 1, cache)

    def test_cache_root_and_install_permissions(self):
        digest, cache = self.cached()
        result = bootstrap.install_bundle("", digest, 1, cache)
        for path in (cache, result):
            with self.subTest(path=path):
                path.chmod(0o777)
                with self.assertRaisesRegex(ValueError, "cache ownership/permissions"):
                    bootstrap.install_bundle("", digest, 1, cache)
                path.chmod(0o755)

    def test_extended_headers_rejected_before_payload_read(self):
        import gzip
        for kind in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK):
            member = tarfile.TarInfo("extended")
            member.type, member.size = kind, bootstrap.MAX_BYTES + 1
            archive = self.root / "extension.tar.gz"
            with gzip.open(archive, "wb") as stream:
                stream.write(member.tobuf())
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "extensions"):
                self.unpack(archive)

    def test_member_and_size_limits(self):
        from unittest.mock import patch
        archive = self.archive()
        with patch.object(bootstrap, "MAX_MEMBERS", 1), self.assertRaisesRegex(ValueError, "limits"):
            self.unpack(archive)
        with patch.object(bootstrap, "MAX_BYTES", 512), self.assertRaisesRegex(ValueError, "limits"):
            self.unpack(archive)

    def test_invalid_reference_digest(self):
        with self.assertRaisesRegex(ValueError, "SHA256"):
            bootstrap.install_bundle("", "x", 1, self.root / "cache")


if __name__ == "__main__":
    unittest.main()
