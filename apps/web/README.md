# 项目门户

门户在 `/` 展示品牌、项目资料和应用入口。页面借鉴 DeepSeek Harness 的应用壳：左栏放应用导航，中央放项目概览，右栏放辅助资料。窄屏从顶栏展开应用导航，辅助资料排在主区下方。布局设置和插件管理始终位于顶栏，偏好按浏览器来源和项目 ID 保存。

## 运行与部署

在仓库根目录使用 Node.js 24：

```sh
npm ci
npm run dev
```

打开 `http://localhost:5180/`。门户可独立运行，无需启动 Workbench 或后端。生产构建使用 `npm run build`，将 `apps/web/dist/` 作为静态站点部署在 `/`。`VITE_*` 配置会进入浏览器产物，修改后需重新构建，不要放入凭据。

在 `apps/web/.env.local` 中参照 [配置示例](.env.example) 设置品牌、项目 ID、名称、简介和仓库链接。`VITE_WORKBENCH_URL` 使用浏览器可访问的 Workbench HTTP(S) 地址，也可用相对于门户来源的路径。地址留空时入口显示「未配置地址」。本地单独启动 Workbench 后，可设置 `VITE_WORKBENCH_URL=http://localhost:5173/work-items`。Workbench 的认证、路由和 API 部署方式见 [Workbench 说明](../../workbench/README.md)。

## 扩展首页

宿主用 [`@ursi/ui-layout`](../../packages/ui-layout/SPEC.md) 排列页头、应用导航、主内容和辅助区，用 [`@ursi/ui-slots`](../../packages/ui-slots/SPEC.md) 管理组件贡献。门户声明 `home.entries`（左侧应用导航）和 `home.aside`（扩展区域），布局位置由门户决定。

新增插件时，在 `src/plugins/` 编写模块，导出 `activate({ slots, signal })`，用 `slots.register` 注册组件。停用时宿主自动移除贡献；插件需要清理额外资源时，可从 `activate` 返回清理函数。将插件登记到 [`src/plugin-manifest.ts`](src/plugin-manifest.ts)，指定本地模块导入和默认开关。清单只登记经过代码审核、随门户构建的源码。不支持通过网址安装插件。

## 验证

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```
