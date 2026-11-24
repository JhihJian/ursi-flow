# 项目门户

门户 `/` 展示项目资料和可选应用入口。`/manage/#pages` 编辑首页文案、仓库地址和布局；`/manage/#plugins` 管理内置插件及 Workbench 地址。两个页面共享草稿，预览使用真实首页组件。最后一版有效草稿保留在当前浏览器标签页，导出后仍需发布才能影响访客。

## 本地运行

在仓库根目录使用 Node.js 24：

```sh
npm ci
npm run dev
```

打开 `http://localhost:5180/`。开发默认配置见 [环境变量示例](.env.example)。可将 `portal-config.json` 放在 `apps/web/public/`，覆盖开发默认值。门户不依赖 Workbench 或业务后端。

## 生产部署与回滚

1. 从管理台导出 `portal-config.json`，或以 [示例配置](portal-config.example.json) 为初始版本。配置只包含公开文案、链接和开关，项目 ID 由 `VITE_PROJECT_ID` 确定。使用浏览器可达的完整 HTTP(S) 地址，或以 `/` 开头的站内路径。设置 Workbench 地址前，参见 [Workbench 部署说明](../../workbench/README.md)。
2. 把配置纳入部署仓库审核。发布前执行 `npm run portal:check-config -- /path/to/portal-config.json`。同一份文件供所有访客读取，未知插件 ID 或无效值会令整份配置校验失败。新登记的插件需要先发布包含它的前端版本，再添加配置项。
3. 运行 `npm run build`，部署 `apps/web/dist/` 下的两份静态页面和带哈希的资源。静态主机须对 `/manage/` 提供 `manage/index.html`，对 `/portal-config.json` 返回 `application/json`，两者和首页应可重新验证缓存，配置建议 `Cache-Control: no-store`。缺失的资源和配置应直接返回 404。按发布单元切换 HTML 并保留旧哈希资源，直到旧页面不再需要它们。
4. 由部署流程将审核后的文件原子替换为同源 `/portal-config.json`。仅改文案、布局、入口或开关无需重建前端。回滚时原子恢复上一版配置，再刷新首页核对布局与入口；如同时回滚前端，先确认旧构建与配置匹配。上线前从实际站点验证 Workbench 跳转到目标页面或登录页。

静态管理台只编辑本地草稿和导出文件，无写入生产的 API。需要限制管理台访问时，由部署网关保护 `/manage/`；生产发布权限由配置仓库和发布流程控制。生产配置缺失、超时或无效时，基础首页仍可访问，插件全部停用。管理台的插件状态来自当前预览，链接状态「已配置」仅表示格式有效，入口可达性由发布验收检查。

## 扩展首页

[`@ursi/ui-layout`](../../packages/ui-layout/SPEC.md) 排列页头、应用导航、主内容和辅助区。[`@ursi/ui-slots`](../../packages/ui-slots/SPEC.md) 管理组件贡献。门户声明 `home.entries`（左侧应用导航）和 `home.aside`（扩展区）。

在 `src/plugins/` 新增模块，导出同步 `activate({ slots, signal })`，用 `slots.register` 注册组件。插件停用时宿主移除贡献，额外资源由 `activate` 返回的清理函数释放。将插件登记到 [源码清单](src/plugin-manifest.ts)，声明贡献位置和本地模块导入。生产配置只能启停经过源码审核并随门户构建的插件。

## 验证

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm run portal:check-config -- apps/web/portal-config.example.json
```

浏览器用例使用生产构建，覆盖草稿隔离、宽窄屏、配置缺失、配置版本回退和插件故障。实际发布前，仍须在目标静态主机验证缓存、旧资源保留和入口跳转。
