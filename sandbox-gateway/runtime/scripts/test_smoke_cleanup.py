#!/usr/bin/env python3
"""Fault-inject smoke setup and verify cleanup without touching Docker."""
import importlib.util
from pathlib import Path
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("smoke", Path(__file__).with_name("smoke-image.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.previous = signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGTERM, self.previous)

    def test_prepare_failure_and_sigterm_remove_private_directory(self):
        for terminate in (False, True):
            created = []
            def command(*args, **_kwargs):
                if args[0] == "ssh-keygen":
                    created.append(Path(args[-1]).parent)
                    if terminate:
                        signal.raise_signal(signal.SIGTERM)
                    raise subprocess.CalledProcessError(1, args)
                return subprocess.CompletedProcess(args, 1, "", "No such container")
            with self.subTest(terminate=terminate), patch.object(smoke, "run", command):
                with self.assertRaises(SystemExit if terminate else subprocess.CalledProcessError):
                    smoke.main()
                self.assertEqual(len(created), 1)
                self.assertFalse(created[0].exists())

    def test_docker_timeout_does_not_skip_other_cleanup(self):
        created, removals = [], []
        def command(*args, **_kwargs):
            if args[0] == "ssh-keygen":
                created.append(Path(args[-1]).parent)
                raise subprocess.CalledProcessError(1, args)
            removals.append(args)
            if len(removals) == 1:
                raise subprocess.TimeoutExpired(args, 40)
            return subprocess.CompletedProcess(args, 1, "", "No such container")
        with patch.object(smoke, "run", command), self.assertRaisesRegex(RuntimeError, "cleanup failed"):
            smoke.main()
        self.assertEqual(len(removals), 4)
        self.assertFalse(created[0].exists())

    def test_resource_removal_failure_is_reported(self):
        created = []
        def command(*args, **_kwargs):
            if args[0] == "ssh-keygen":
                created.append(Path(args[-1]).parent)
                raise subprocess.CalledProcessError(1, args)
            if args[:2] == ("docker", "inspect"):
                return subprocess.CompletedProcess(args, 0, "exists", "")
            return subprocess.CompletedProcess(args, 1, "", "removal failed")
        with patch.object(smoke, "run", command), self.assertRaisesRegex(RuntimeError, "cleanup failed"):
            smoke.main()
        self.assertFalse(created[0].exists())


if __name__ == "__main__":
    unittest.main()
