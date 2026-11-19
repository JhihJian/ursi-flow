# 轨迹查看器（上游快照）

`components/` 与 `lib/` 直接来自 [pi-agent-trajectory-viewer](../../../../pi-agent-trajectory-viewer)，
提交与同步来源记录在 `VENDOR.json`。控制台不在这里改轨迹界面：需要调整交互或样式时先改上游项目，
再运行下面的同步命令。

```sh
cd flow-runtime/web
npm run sync:trajectory
```

脚本只重铺 `components/` 与 `lib/`，保留本目录的 `host.css`、`theme-bridge.css` 与这份说明；同时把参考
样式里写在 `body`、`:root`、滚轮与焦点选择器上的规则收进 `.trajectory-host`，避免影响控制台其余页面。
`theme-bridge.css` 把查看器的表面、文字与描边映射到控制台主题，`host.css` 提供工作区的宿主布局。

轨迹数据由 `RunTrajectory.tsx` 接到 `/api/v1/runs/:id/nodes/:nodeId/trajectory`，内容是 daemon 按节点执行
保存的 Pi 会话 JSONL 切片；切片保留原始 `id`/`parentId`，会话头是合成值，不能当成可续接的 Pi 会话。

第三方许可见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`（组件样式与时间线迁移自 DeepSeek harness）。
