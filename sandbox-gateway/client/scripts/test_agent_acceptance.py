"""验收脚本的本地策略测试，不启动 Docker、Gateway 或真实模型。"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
source = Path(__file__).with_name("agent_acceptance.py")
spec = importlib.util.spec_from_file_location("agent_acceptance", source)
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class CleanupTests(unittest.TestCase):
    def test_wrong_scope_is_never_deleted(self):
        with tempfile.TemporaryDirectory() as temporary:
            case = acceptance.Acceptance(types.SimpleNamespace(), temporary)
            with mock.patch.object(case, "owned", return_value=["foreign-resource"]), \
                 mock.patch.object(acceptance, "run", return_value=types.SimpleNamespace(
                     stdout=json.dumps([{"Config": {"Labels": {"io.ursi.scope": "someone-else"}}}]))) as command:
                with self.assertRaises(acceptance.AcceptanceError):
                    case.cleanup()
                self.assertEqual(command.call_count, 1)
                self.assertEqual(command.call_args.args[0], ["docker", "inspect", "foreign-resource"])

    def test_cleanup_only_removes_exact_random_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            case = acceptance.Acceptance(types.SimpleNamespace(), temporary)
            resources = {False: ["owned-container"], True: ["owned-volume"]}
            commands = []

            def run(argv):
                commands.append(argv)
                if argv[:3] in (["docker", "ps", "-aq"], ["docker", "volume", "ls"]):
                    self.assertEqual(argv[-2:], ["--filter", "label=io.ursi.scope=" + case.scope])
                    return types.SimpleNamespace(stdout="\n".join(resources[argv[1] == "volume"]))
                if "inspect" in argv:
                    labels = {"Labels": {"io.ursi.scope": case.scope}}
                    info = labels if argv[1] == "volume" else {"Config": labels}
                    return types.SimpleNamespace(stdout=json.dumps([info]))
                if "rm" in argv:
                    resources[argv[1] == "volume"].remove(argv[-1])
                    return types.SimpleNamespace(stdout="")
                self.fail("unexpected command")

            with mock.patch.object(acceptance, "run", side_effect=run):
                case.cleanup()
            self.assertTrue(case.report["cleanup"])
            self.assertIn(["docker", "rm", "-f", "owned-container"], commands)
            self.assertIn(["docker", "volume", "rm", "owned-volume"], commands)
            self.assertFalse(any("prune" in command for command in commands))

    def test_opt_in_gate_precedes_tools_and_resources(self):
        env = os.environ.copy()
        env.pop("URSI_AGENT_ACCEPTANCE", None)
        result = subprocess.run([sys.executable, str(source), "--gateway", "/absent-gateway",
                                 "--client", "/absent-client", "--bundle", "/absent-bundle",
                                 "--config-dir", "/absent-config"], env=env, capture_output=True,
                                text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("URSI_AGENT_ACCEPTANCE=1", result.stderr)


class ProcessEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.proc = Path(self.temporary.name)
        self.marker = "unique-tool-marker"
        self.pids = [101, 102, 103]
        for pid in self.pids:
            entry = self.proc / str(pid)
            entry.mkdir()
            # 监督器属于 root，工具属于 agent。stat comm 包含括号与空格。
            (entry / "status").write_text("Uid:\t" + ("0" if pid == 103 else "1000") + "\n")
            (entry / "stat").write_text(f"{pid} (process (name)) S 1 2 3\n")
            args = b"service\0--ursi-pi-supervisor\0" if pid == 103 else self.marker.encode() + b"\0"
            (entry / "cmdline").write_bytes(args)

    def probe(self, alive):
        script = acceptance.process_check_script(self.pids, 103, self.marker, alive=alive)
        code = script.removeprefix("python3 - <<'PY'\n").removesuffix("PY\n")
        with mock.patch("pathlib.Path", return_value=self.proc):
            exec(compile(code, "process-evidence", "exec"), {})

    def test_root_supervisor_does_not_require_kill_zero_permission(self):
        with mock.patch.object(os, "kill", side_effect=PermissionError("EPERM")) as kill:
            self.probe(alive=True)
        kill.assert_not_called()

    def test_supervisor_must_have_root_identity(self):
        (self.proc / "103" / "status").write_text("Uid:\t1000\n", encoding="utf-8")
        with self.assertRaisesRegex(AssertionError, "root-owned"):
            self.probe(alive=True)

    def test_missing_pid_and_zombie_cannot_count_as_live(self):
        (self.proc / "103" / "stat").write_text("103 (supervisor) Z 1 2 3\n")
        with self.assertRaisesRegex(AssertionError, "not live"):
            self.probe(alive=True)
        (self.proc / "103" / "stat").unlink()
        with self.assertRaises(FileNotFoundError):
            self.probe(alive=True)

    def test_wrong_supervisor_or_tool_identity_fails(self):
        for pid in (101, 103):
            with self.subTest(pid=pid):
                path = self.proc / str(pid) / "cmdline"
                original = path.read_bytes()
                path.write_bytes(b"unrelated-process\0")
                with self.assertRaisesRegex(AssertionError, "identity mismatch"):
                    self.probe(alive=True)
                path.write_bytes(original)

    def remove_tracked(self):
        for entry in list(self.proc.iterdir()):
            for path in entry.iterdir():
                path.unlink()
            entry.rmdir()

    def test_cancel_requires_all_pids_and_marked_descendants_gone(self):
        with self.assertRaisesRegex(AssertionError, "PID remains"):
            self.probe(alive=False)
        self.remove_tracked()
        self.probe(alive=False)
        descendant = self.proc / "104"
        descendant.mkdir()
        (descendant / "cmdline").write_bytes(b"python3\0" + self.marker.encode() + b"\0")
        with self.assertRaisesRegex(AssertionError, "descendant remains"):
            self.probe(alive=False)

    def test_scan_permission_error_is_not_silently_accepted(self):
        self.remove_tracked()
        (self.proc / "104").mkdir()
        with mock.patch.object(Path, "read_bytes", side_effect=PermissionError("unreadable")):
            with self.assertRaises(PermissionError):
                self.probe(alive=False)


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.case = acceptance.Acceptance(types.SimpleNamespace(client="client", operation_timeout=5),
                                          self.temporary.name)
        self.case.stage = "cancel"
        self.case.substage = "process_identity_before_cancel"
        self.secret = "private-key-model-config-and-prompt-canary"

    def test_failed_command_preserves_only_category_exit_and_substage(self):
        result = types.SimpleNamespace(returncode=7, stdout=self.secret, stderr=self.secret)
        with mock.patch.object(acceptance, "run", return_value=result):
            with self.assertRaises(acceptance.AcceptanceError) as raised:
                self.case.cli("ssh", self.secret, self.secret)
        details = self.case.failure_details(raised.exception)
        self.assertEqual(details["stage"], "cancel")
        self.assertEqual(details["substage"], "process_identity_before_cancel")
        self.assertEqual(details["command"], "ssh")
        self.assertEqual(details["exit_code"], 7)
        self.assertNotIn(self.secret, json.dumps(details))

    def test_timeout_startup_and_invalid_json_are_sanitized(self):
        cases = [subprocess.TimeoutExpired(["client", self.secret], 5, output=self.secret, stderr=self.secret),
                 OSError(self.secret), None]
        for error in cases:
            with self.subTest(error=type(error).__name__):
                result = types.SimpleNamespace(returncode=0, stdout=self.secret, stderr=self.secret)
                with mock.patch.object(acceptance, "run", side_effect=error, return_value=result):
                    with self.assertRaises(acceptance.AcceptanceError) as raised:
                        self.case.cli("acp", "cancel", self.secret)
                details = self.case.failure_details(raised.exception)
                self.assertEqual(details["command"], "acp cancel")
                self.assertEqual(details["exit_code"], 0 if error is None else None)
                self.assertNotIn(self.secret, json.dumps(details))

    def test_unknown_command_arguments_never_become_diagnostics(self):
        self.assertEqual(acceptance.command_category(("acp", self.secret)), "unknown")
        self.assertEqual(acceptance.command_category((self.secret,)), "unknown")
        self.assertNotIn(self.secret, json.dumps(self.case.failure_details(ValueError(self.secret))))

    def test_root_gate_precedes_tools_config_and_resource_access(self):
        with mock.patch.object(acceptance, "parse_args", return_value=types.SimpleNamespace()), \
             mock.patch.dict(os.environ, {"URSI_AGENT_ACCEPTANCE": "1"}), \
             mock.patch.object(acceptance.sys, "platform", "linux"), \
             mock.patch.object(os, "geteuid", return_value=1000), \
             mock.patch.object(acceptance.shutil, "which") as which, \
             mock.patch.object(acceptance.Acceptance, "prepare") as prepare:
            with self.assertRaisesRegex(acceptance.AcceptanceError, "sudo.*root"):
                acceptance.main()
        which.assert_not_called()
        prepare.assert_not_called()


if __name__ == "__main__":
    unittest.main()
