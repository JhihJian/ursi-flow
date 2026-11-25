#!/usr/bin/env python3
"""在临时 Docker 沙箱中验证一个可信示例补丁。退出码：0 通过，1 测试失败，2 环境或清理失败。"""
import argparse
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile

HERE = Path(__file__).resolve().parent
PRODUCT = HERE.parents[1]
REPO = "/ursi/workspace/release-review"
sys.dont_write_bytecode = True
sys.path.insert(0, str(PRODUCT / "client/scripts"))
from agent_acceptance import Acceptance, AcceptanceError, private_write, require


def review(job, patch):
    job.ssh(f"mkdir -m 700 {REPO}\n")
    connection = (job.host, str(job.port), job.identity, job.known_hosts)
    for name in ("release.py", "test_release.py", patch):
        job.cli("sftp-put", *connection, HERE / name, f"{REPO}/{name}")

    # 固定提交时间，使两个候选从相同的基线提交开始。
    job.ssh(f"""cd {REPO}
git init -q
git add -- release.py test_release.py
export GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z
git -c user.name=Review -c user.email=review@localhost commit -qm baseline
git apply --index {patch}
""")
    client_code, result = job.ssh(
        f"cd {REPO} || exit 2\nexec python3 -B -m unittest -v test_release\n", check=False)
    require(isinstance(result, dict), "SSH 未返回测试结果")
    sys.stdout.write(result["stdout"])
    sys.stderr.write(result["stderr"])
    code = result["code"]
    require(code in (0, 1) and client_code == code and result["success"] is (code == 0),
            f"远程测试未正常完成（SSH 退出码 {code}）")
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", choices=("v1", "v2"))
    parser.add_argument("--gateway", type=Path, default=PRODUCT / "target/debug/ursi-gateway")
    parser.add_argument("--client", type=Path, default=PRODUCT / "target/debug/ursi-sandbox-client")
    parser.add_argument("--bundle", type=Path, default=PRODUCT / "dist/runtime-bundle.tar.gz")
    parser.add_argument("--image", default="ursi-runtime-pi:local")
    parser.set_defaults(ssh_key=None, bundle_host=None, operation_timeout=60, lifecycle_timeout=240)
    args = parser.parse_args()
    require(sys.platform.startswith("linux") and os.geteuid() == 0, "请在 Linux 上使用 sudo 运行")
    for program in ("docker", "ssh", "sftp", "ssh-keygen"):
        require(shutil.which(program), "缺少工具 " + program)
    args.client, args.gateway = args.client.resolve(), args.gateway.resolve()
    for binary in (args.client, args.gateway):
        require(binary.is_file() and os.access(binary, os.X_OK), f"请构建或指定可执行文件：{binary}")
    require(args.bundle.is_file(), "请构建或指定正式 bundle")
    patch = args.candidate + ".patch"
    for name in ("release.py", "test_release.py", patch):
        require((HERE / name).is_file(), "缺少示例文件 " + name)

    def interrupted(signum, frame):
        raise AcceptanceError("补丁验证收到中断信号")

    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    with tempfile.TemporaryDirectory(prefix="ursi-release-review-", dir="/tmp") as temporary:
        root = Path(temporary)
        args.config_dir = root / "seed"
        (args.config_dir / "pi").mkdir(parents=True)
        private_write(args.config_dir / "pi/models.json", "{}")
        private_write(args.config_dir / "session.json", '{"provider":"unused","model":"unused"}')
        job = Acceptance(args, root)
        print(f"候选：{patch}，资源 scope：{job.scope}", file=sys.stderr, flush=True)
        try:
            job.prepare()
            job.create()
            code = review(job, patch)
            job.delete()
            return code
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            job.cleanup()
            require(job.report["cleanup"], "清理后仍有本次运行的资源")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"补丁验证基础设施故障：{error}", file=sys.stderr)
        sys.exit(2)
