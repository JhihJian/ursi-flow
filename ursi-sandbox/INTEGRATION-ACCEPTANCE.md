# 历史记录：Flow Runner 与 Runtime ACP 联合验收

**2026-11-18 UTC：文本调用和正常关闭通过。** Flow Runner 与独立 CLI 各自连接同一个正式 session-service，分别完成一轮 ACP 会话。服务取自独立构建的 dist bundle，在正式 Runtime 镜像内启动真实 Pi 1.5.0。模型端点是本地确定性替身，通过 OpenAI Chat Completions SSE 固定返回 `ACP-OK`，不做推理。用全新容器复跑一次，结果一致。

## 断言与结果

| 调用方 | 实际执行与观测 |
| --- | --- |
| Flow Runner | 运行当时的 `server/tests/real_runtime_acp.rs`，`flow_runner_can_verify_real_runtime_acp ... ok`，`1 passed; 0 failed; 0 ignored`。Runner 成功返回要求 `end_turn` 和 close 成功；测试直接断言回流文本非空。此时替身恰好服务 1 次，唯一的持久化会话记录为 `cwd=/ursi/workspace/repo`、`state=closed`、`cleanupFailed=false`。 |
| 独立 CLI | 同一端点和令牌，新建第二个会话。按该会话 ID 拼接 `agent_message_chunk` 得到精确文本 `ACP-OK`，最终结果为 `stopReason=end_turn`，退出码为 0。close 后通过新连接查询，状态为 `closed`、`pid=null`。此时替身累计服务 2 次，两个会话都在 `/ursi/workspace/repo` 正常关闭。 |
| 清理 | 两轮会话各自关闭后 `/run/ursi/sessions` 均为空。脚本退出后按 `ursi-acp-check.*` 前缀检查容器、Docker 网络及宿主 `/tmp` 临时目录，残留数均为 0。 |

## 产物标识

Flow 源码提交：`e7a100f94fa2c479de7b113586d9af60128b4875`。独立构建目录：`/tmp/ursi-standalone.frBKhQ`。bundle 内服务的 SHA-256 与该目录 `target/debug/ursi-session-service` 相同。

| 实测产物 | SHA-256 |
| --- | --- |
| `ursi-runtime-pi:local`，linux/amd64，Docker image ID | `62cbb9b1cffb4a35562b5797cc46f48a5616cda315b016f1f29b00ccc8514419` |
| `dist/runtime-bundle.tar.gz` | `bea85bd9a8277f5e477628919029676ec390b5030ca111c445b2944ff0cd6081` |
| bundle 内 `bin/ursi-session-service` | `7af5c15cdd456ed26c06af30af7f8985d6b2fcd0aae90777c6756062cdf5f4f2` |
| 独立 `target/debug/ursi-sandbox-client` | `639bace3039612b8981d6c5c4dbd66452fe4bf964265359e774694a6adfc95c9` |

## 复验

复验脚本随记录保存在提交 `a123a10`。在该版本的仓库根目录运行以下命令。当前 Server 使用本机 `ursi-flowd`，部署见 [Server 使用说明](../workbench/server/README.md)。需要本机 Linux Docker、宿主到 internal bridge 容器 IP 的路由、上述镜像和独立产物、Rust 工具链、Bash、curl、jq、OpenSSL。脚本核对 dist 校验文件，按本地镜像 ID 启动容器并输出产物摘要，可与上表比对。

```bash
CARGO_TARGET_DIR=/data/dev/ursi-flow/target \
  bash server/tests/scripts/verify_runtime_acp.sh /tmp/ursi-standalone.frBKhQ
```

该版本的复验脚本 创建独立 Docker internal 网络，无宿主目录挂载或端口发布。宿主客户端直连容器的 `/acp`，只有容器内进程能访问该版本的模型替身。每次运行生成 32 字节随机 session token，宿主令牌文件权限为 `0600`，容器内令牌和合成模型配置位于 `/run` 的 tmpfs。Pi 只使用服务生成的会话配置，未读取宿主 Pi 凭据。脚本退出时删除容器、网络及宿主临时目录。

验收范围为工作目录已经准备好的 Runner/CLI 到 Runtime ACP 的文本调用及正常关闭。容器直接启动 bundle 中的服务；镜像 bootstrap、Gateway 生命周期、SSH/SFTP、Flow HTTP 工作流、取消、工具执行和真实模型能力均未在此验证。
