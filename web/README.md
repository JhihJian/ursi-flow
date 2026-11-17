# ursi-flow Web

Vue 3 + TypeScript 前端工程，按 server 的六个业务域组织。当前可运行应用壳、导航和模块初始化页，业务表单、接口与实时事件按各模块规格继续交付。

## 本地开发

使用 Node.js 24 和 npm，在 web 目录执行：

```bash
npm ci
npm run dev
```

开发服务监听 `0.0.0.0:5173`。可复制 `.env.example` 为 `.env.local`，用 `URSI_API_PROXY` 指定服务端地址。默认 `/api` 代理到 `http://127.0.0.1:8080`，当前初始化页面不请求业务 API，后端未启动时仍可浏览导航。

## 验证

```bash
npm run check
npx playwright install chromium
npm run test:e2e
```

`check` 依次执行 ESLint、Vitest、vue-tsc 和 Vite 构建。类型检查包含应用、单元测试、浏览器测试和 TypeScript 配置。ESLint 检查静态导入的模块依赖方向。

浏览器测试自行构建并启动 `0.0.0.0:4173` 预览服务，覆盖桌面和移动 Chromium 的模块导航、深链刷新、未知路由、键盘跳转和懒加载失败。测试结束后自动关闭服务，运行前保持 4173 端口空闲。

只运行部分测试：

```bash
npm test -- src/shared
npm test -- src/app
npm run test:e2e -- --project=desktop
```

业务测试放在对应模块目录，可以用 `npm test -- src/modules/roles` 选择角色模块已实现的测试。

## 构建与托管

```bash
npm run build
npm run preview
```

产物输出到 `web/dist`，预览服务监听 `0.0.0.0:4173`。生产由 server transport 或独立静态服务托管，页面导航需要 history 回退。`/api`、`/api/*` 和静态资源缺失请求必须保留相应错误，不能返回 SPA HTML。Vite preview 用于本地预览，服务端托管仍需联合验收。

## 模块导航

- [模块地图与总规格](SPEC.md)
- [设计、依赖方向和交付边界](DESIGN.md)
- [应用装配](src/app/SPEC.md)与[共享基础](src/shared/SPEC.md)
- [流程](src/modules/workflows/SPEC.md)、[角色](src/modules/roles/SPEC.md)、[运行](src/modules/runs/SPEC.md)
- [产物](src/modules/artifacts/SPEC.md)、[沙箱](src/modules/sandboxes/SPEC.md)、[模型连接](src/modules/connections/SPEC.md)

各域按需增加 API、DTO、组件、状态与测试。Pinia 已装配，共享状态随实际需求建立；运行状态机和数据库事务由服务端负责。
