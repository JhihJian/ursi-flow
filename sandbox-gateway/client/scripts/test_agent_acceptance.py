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
        self.assertIn("AcceptanceError", result.stderr)


if __name__ == "__main__":
    unittest.main()
