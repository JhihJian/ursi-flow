# PlanWeave TODO 与 Canvas Map

独立的浏览器演示。TODO、Canvas Map 和全项目的只读任务图共用 Release Workspace 样例，并沿用 PlanWeave 的组件和主题。静态站点可独立部署，运行时不连接 Workbench、PlanWeave Runtime 或 Electron。

## 启动与发布

在 `planweave-demo/` 中使用 Node.js 20.19+（20.x）或 22.12+：

```bash
npm ci
npm run dev -- --port 5183
```

打开 `http://localhost:5183/#/map`、`http://localhost:5183/#/todo` 或 `http://localhost:5183/#/graph`。发布时运行 `npm run build`，将 `dist/` 交给静态文件服务器。资源使用相对路径，页面用哈希导航，可部署在子目录，无需配置路由回退或设置环境变量。随构建产物分发时应保留 [LICENSE](LICENSE)。

## 工作区与交互

桌面布局沿用原版尺寸：左侧项目栏 280 px，工作区标题栏 44 px，地图检查器 320 px，TODO 组件栏 300 px。中间区域占据剩余空间。组件栏为只读目录。窄屏通过标题栏开关打开项目栏或组件栏。

- **项目树**：项目名返回总地图。画布名定位到该画布的节点组，任务名选中并居中单个节点。所有定位都在同一张项目任务图上进行，节点与连线始终保留。点开节点内的任务块可查看只读详情。
- **TODO**：按画布阶段查看就绪与阻塞待办，按状态查看任务块、负责人、依赖和评审门禁。点开条目可查看只读详情。
- **Canvas Map**：选择节点或依赖线查看检查器；双击节点或使用箭头打开画布。右键菜单提供工作包预览、复制样例范围和重命名。地图可以平移、缩放、拖拽定位并恢复默认布局。
- **浏览器存储**：拖拽、名称与策略按项目写入 `localStorage`。布局重置只清除坐标。执行策略仅用于本地演示。包路径是样例文本，剪贴板须使用浏览器信任的上下文（如 localhost 或 HTTPS）。

## 验证

```bash
npx playwright install chromium
npm test
```

测试以静态构建为对象，覆盖项目树的图上定位、详情导航、地图检查器、布局持久化、保存失败重试、窄屏触屏及资源请求。桌面和窄屏截图写入 `test-results/`。

## 上游授权

页面和主题代码改编自 [GaosCode/PlanWeave](https://github.com/GaosCode/PlanWeave/tree/42d38130590a0d29ee9dae9a95a4b62728a17f4d) 的桌面渲染器及显示数据类型。上游 MIT 版权和许可见 [LICENSE](LICENSE)。
