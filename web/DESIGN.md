# Web 模块设计与交付边界

## 技术与组织

前端采用 Vue 3、TypeScript、Vite、Vue Router、Pinia 和 Tailwind CSS，参考 Grasp 的基础技术栈。Vitest、Vue Test Utils 与 Happy DOM 用于单元和组件测试，Playwright 用于构建产物的浏览器验收，ESLint 与 vue-tsc 检查源码和测试。

web 是单独的 npm 包，以 package-lock.json 固定依赖。开发环境使用 Node.js 24，构建输出为 web/dist。Pinia 在入口装配，有实际共享状态需求时再建立模块 store。图展示、终端与编辑器依赖随对应业务能力引入。

## 目录与职责

| 路径 | 职责 | 服务端对应 |
|---|---|---|
| src/app | 应用壳、导航、路由装配、全局样式及错误页面 | app 的前端入口职责 |
| src/modules/workflows | 流程定义、图展示、角色选择与启动入口 | server/src/workflows |
| src/modules/roles | 角色配置、Skills、MCP 和复制编辑 | server/src/roles |
| src/modules/runs | 运行查询、快照、审批、事件和当前结果 | server/src/runs |
| src/modules/artifacts | 产物查询、预览、下载和执行归属 | server/src/artifacts |
| src/modules/sandboxes | 沙箱关联、状态与获准连接入口 | server/src/sandboxes |
| src/modules/connections | 模型连接配置与凭据引用 | server/src/connections |
| src/shared | 无业务归属的 UI 和 HTTP 基础能力 | 对接 transport，复用基础协议 |
| e2e | 跨模块浏览器验收 | 应用联合验收 |

后端 storage 的数据库、事务和 repository 留在服务端。前端共享请求入口归 shared，各域 API 与响应类型归本域；前端不重复实现运行状态机、引用检查或数据库模型。

## 依赖方向

app 导入各业务模块公开的 routes.ts，按需加载页面。业务模块依赖 shared，shared 保持独立。ESLint 检查静态导入中的反向依赖及跨业务域依赖。

跨域跳转使用路由地址和资源标识，模块不导入另一个域的内部 View、store 或 API。页面确需组合多个域时，由 app 调用各域公开组件或接口组合。原始请求、事件连接和订阅应随组件或用例生命周期释放。

每个模块以 routes.ts 和入口 View 开始。业务功能增加后，在本域按需增加 api.ts、types.ts、components、composables、store 和就近测试，公共目录只接收具有真实复用需求的实现。

## 路由与 API

六个一级路由为 /workflows、/roles、/runs、/artifacts、/sandboxes、/connections。根地址跳转 /workflows，未知页面显示 404 并提供返回入口。模块页面懒加载，应用壳负责标题、当前导航和加载失败提示。

浏览器业务请求使用同源 /api 前缀。开发时由 Vite 将 /api 代理到 URSI_API_PROXY，默认 http://127.0.0.1:8080，代理支持 WebSocket。该变量仅由开发服务读取，凭据不放入 VITE_* 变量或前端包。具体业务路径、字段及 SSE 事件封装在服务端接口确定后由所属模块接入。

共享 HTTP 函数保留 JSON 响应原结构，204 返回空值，HTTP 错误仅保留状态码和固定提示，不展示原始上游正文。取消信号交给 fetch，调用方决定取消后的界面状态。页面只呈现服务端确认的业务结果。

## 静态托管约定

生产资源从 web/dist 发布，当前应用部署于站点根路径 /。Browser history 模式要求静态服务将页面导航的未知路径回退到 index.html，由前端显示模块页或 404。

/api 及 /api/*、/assets/* 等静态文件请求必须由相应 API 或资源处理器响应。缺失 API、脚本和样式不得回退 HTML。server 的 transport 规格承接这一约定，Vite preview 仅用于构建产物预览与浏览器检查。

## 分模块交付

| 交付层次 | 环境与可观察结果 | 证据边界 |
|---|---|---|
| 工程初始化 | npm ci、lint、类型检查、Vitest、构建与导航测试 | 工程、入口和应用壳可运行 |
| 业务模块独立交付 | 本域页面与 API 替身，验证表单、状态展示、错误与清理 | 界面行为遵循请求响应契约 |
| 服务端联合交付 | 真实 transport、业务服务和持久化存储 | 引用、快照、审批、产物和凭据规则成立 |
| 执行链路联合交付 | 真实 Gateway、Channel、Agent Runtime 和 CLI | 沙箱、执行配置、产物回收实际生效 |

初始化页面统一显示功能准备中与规划能力，没有业务记录、保存成功反馈或可执行业务按钮。真实 CRUD、审批、事件订阅和连接操作按各模块规格逐项交付。角色和模型连接可独立进行表单与接口测试，运行与产物通过固定执行轮次夹具验证展示，跨模块业务一致性由真实服务端验收。
