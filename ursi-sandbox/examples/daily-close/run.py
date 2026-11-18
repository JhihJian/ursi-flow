#!/usr/bin/env python3
"""在独立的 Docker 沙箱内运行门店日结，成功时输出本机报表路径。"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile

HERE = Path(__file__).resolve().parent
PRODUCT = HERE.parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(PRODUCT / "client/scripts"))
from agent_acceptance import Acceptance, AcceptanceError, private_write, require, sha


class DailyClose(Acceptance):
    def record(self, name, **facts):
        # stdout 留给取报表的调用方，验收脚本的模型报告不对外发布。
        print(name, file=sys.stderr, flush=True)

    def run_job(self, orders):
        self.stage = "日结"
        self.ssh("mkdir -m 700 /ursi/workspace/daily-close\n")
        connection = (self.host, str(self.port), self.identity, self.known_hosts)
        remote = "/ursi/workspace/daily-close/"
        for name, source in (("close.py", HERE / "close.py"), ("orders.csv", orders)):
            local = self.root / name
            shutil.copyfile(source, local)
            self.cli("sftp-put", *connection, local, remote + name)
        self.ssh("cd /ursi/workspace/daily-close\npython3 close.py orders.csv report.csv\ntest -s report.csv\n")
        report = self.root / "report.csv"
        self.cli("sftp-get", *connection, report, remote + "report.csv")
        require(report.stat().st_size > 0, "下载的报表为空")
        return report


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orders", type=Path, help="自带订单 CSV，跳过示例 expected.csv 比对")
    parser.add_argument("--gateway", type=Path, default=PRODUCT / "target/debug/ursi-gateway")
    parser.add_argument("--client", type=Path, default=PRODUCT / "target/debug/ursi-sandbox-client")
    parser.add_argument("--image", default="ursi-runtime-pi:local")
    parser.add_argument("--bundle", type=Path, default=PRODUCT / "dist/runtime-bundle.tar.gz")
    parser.add_argument("--bundle-host", help="容器可访问的宿主地址，默认探测 Docker bridge")
    parser.set_defaults(ssh_key=None, operation_timeout=60, lifecycle_timeout=240)
    return parser.parse_args()


def run(args, root):
    args.config_dir = root / "seed"
    (args.config_dir / "pi").mkdir(parents=True)
    private_write(args.config_dir / "pi/models.json", "{}")
    private_write(args.config_dir / "session.json", '{"provider":"unused","model":"unused"}')
    job = DailyClose(args, root)
    job.report["real_model"] = False
    print("资源 scope：" + job.scope, file=sys.stderr, flush=True)
    try:
        job.prepare()
        job.create()
        report = job.run_job(args.orders or HERE / "orders.csv")
        if args.orders is None:
            require(sha(report) == sha(HERE / "expected.csv"), "下载报表与示例 expected.csv 不一致")
        job.delete()
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        job.cleanup()
        require(job.report["cleanup"], "清理后仍有本次运行的资源")
    return report


def main():
    args = arguments()
    require(sys.platform.startswith("linux") and os.geteuid() == 0, "请在 Linux 上使用 sudo 运行")
    for program in ("docker", "ssh", "sftp", "ssh-keygen"):
        require(shutil.which(program), "缺少工具 " + program)
    for path in (args.client, args.gateway):
        require(path.is_file() and os.access(path, os.X_OK), "请构建或指定可执行的 Gateway 和客户端")
    args.client, args.gateway = args.client.resolve(), args.gateway.resolve()
    require(args.bundle.is_file(), "请构建或指定正式 bundle")
    require((HERE / "close.py").is_file() and (args.orders or HERE / "orders.csv").is_file(), "缺少日结程序或订单文件")
    require(args.orders is not None or (HERE / "expected.csv").is_file(), "缺少示例 expected.csv")
    uid, gid = (int(os.environ.get(name, "0")) for name in ("SUDO_UID", "SUDO_GID"))
    os.umask(0o077)

    def interrupted(signum, frame):
        raise AcceptanceError("日结收到中断信号")

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    output = Path(tempfile.mkdtemp(prefix="ursi-daily-close-", dir="/tmp"))
    try:
        with tempfile.TemporaryDirectory(prefix="ursi-private-", dir="/tmp") as temp:
            report = run(args, Path(temp))
            report.chmod(0o600)
            report.rename(output / "report.csv")
            summary = {"passed": True, "cleanup": True, "real_model": False,
                       "expected_csv": "matched" if args.orders is None else "not_applicable"}
            private_write(output / "summary.json", json.dumps(summary, indent=2) + "\n")
        # 先完成所有 root 写入，最后才开放目录给 sudo 调用者。
        for path in output.iterdir():
            os.chown(path, uid, gid)
        os.chown(output, uid, gid)
    except BaseException:
        shutil.rmtree(output)
        raise
    print(output / "report.csv")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = str(error) if isinstance(error, AcceptanceError) else type(error).__name__
        print("日结失败：" + detail, file=sys.stderr)
        sys.exit(1)
