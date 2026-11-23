# Workbench 执行器接入

Workbench Server 是[执行器平台](../executor-platform/server/README.md)的 HTTP 消费者。它解析业务工作包、提交输入快照并代理尝试和制品读取。平台管理配置包、后端和执行器修订，并以 ACP v2 stdio 执行 Agent。整条 Flow 的启停仍使用 Flow Runtime。

## 部署与选版

在 Workbench Server 配置 `URSI_EXECUTOR_PLATFORM_URL` 与 `URSI_EXECUTOR_PLATFORM_TOKEN`，令牌对应平台的 `URSI_EXECUTOR_PLATFORM_WORKBENCH_TOKEN`，只供服务出站使用。[Server 部署说明](server/README.md)说明浏览器令牌与 Runtime 凭证的配置。平台管理页负责[登记和检查后端](../executor-platform/server/src/work/agent_backends/README.md)、试跑和发布。若从 MCP 切换，先发布新的 ACP 修订再更新调用方的选择，原完成结果仍可用原 ID 查询。

## Workbench HTTP 接口

路径相对于 Workbench 的 `/api/v2`，使用 `Authorization: Bearer <URSI_API_TOKEN>`。先生成并保存小写标准 UUID，随后以该 ID 查询、重复提交或取消。

| 方法与路径 | 请求与语义 |
| --- | --- |
| `GET /executors` | 读取可供选版的执行器元数据。历史修订见 `/executors/{id}/revisions`。 |
| `PUT /executor-attempts/{attemptId}` | 提交固定的 `executorRef`、非空 UTF-8 指令和可选 `workPatchId`。Workbench 将本地工作包转换为平台接受的 `inputs` 快照，包 ID 不出业务服务。 |
| `GET /executor-attempts/{attemptId}` | 查原尝试；回执丢失后使用同一路径，不启动新任务。 |
| `POST /executor-attempts/{attemptId}/cancel` | 不带正文。为原尝试请求取消，以查询确认结果。 |

```json
{
  "executorRef": {"id":"reviewer","revision":2},
  "workInstruction": {"text":"检查工作包并给出审核结论。","encoding":"utf-8"},
  "workPatchId": "<工作包 ID>"
}
```

同 ID、同请求查回原尝试，改动请求或输入快照返回 409。`unverified` 表示证据待核实。收到终态的 `artifactDirectoryId`（`platform-artifact-{attemptId}`）后，用 `/directories/{artifactDirectoryId}/tree` 列文件，用 `/directories/{artifactDirectoryId}/file?path=answer.md` 读取正文。代理仅提供只读制品。归一化事件分页是[平台直连接口](../executor-platform/server/README.md#事件分页)，使用尝试归属角色的服务令牌，Workbench 不代理此接口。

从 Workbench 启动 Flow 时，Workbench 将执行器引用交给 Runtime；Runtime 用自己的服务身份委派 Agent 节点并校验节点结果。独立的整条 Flow MCP 集成不参与这两条路径。
