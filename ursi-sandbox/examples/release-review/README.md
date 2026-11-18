# 合并前检查：发布工具会选错版本吗？

发布脚本要从一组 Git 标签中选最新版。原来使用 `1.9`、`1.10`，现在也要支持 `v1.2`、`v1.3`。维护者拿到两份候选补丁，需要知道哪份既满足新需求，又保留原来的排序规则。

- [第一版](v1.patch) 去掉前缀后直接比较字符串。新增的前缀用例通过，但 `1.9` 被排在 `1.10` 之后，发布工具会选中旧版本。
- [修正版](v2.patch) 去掉前缀后按整数逐段比较，仍返回原始标签。两份补丁只改 [release.py](release.py)，共用同一组[回归测试](test_release.py)。

## 自己跑一次

在受控 Linux 开发机上准备 Docker、本机 bridge 网络、Python 3 和 OpenSSH 客户端。从 `ursi-sandbox/` 按[构建说明](../../README.md)准备三个二进制、镜像及 bundle。每条命令临时创建一个沙箱和 root 私有配置，经 SFTP 上传代码、通过 SSH 应用 Git 补丁并运行 unittest。请使用可信的构建产物。临时 Gateway 和 bundle 服务会监听随机端口。

```bash
sudo python3 -I -B examples/release-review/run.py v1
sudo python3 -I -B examples/release-review/run.py v2
```

第一条命令**预期返回 1**：`test_unprefixed_numeric_order` 失败，`actual 1.9, expected 1.10`。第二条返回 0：三项测试通过。终端显示容器内 Python 的测试输出，可查看失败的具体断言。若返回 2，表示运行入口、基础设施或资源清理失败，不能据此评价补丁。

这两条命令已在正式 Docker Runtime 实测，两次运行均确认所属容器和卷释放。示例演示研发人员在合并前做的回归检查，不需要模型凭据；不会修改开发者的仓库，也不会在代码托管平台自动合并 PR。
