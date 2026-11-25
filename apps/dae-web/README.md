# dae 路由观察台

本机 dae 的观察与配置界面。前端直接消费 dae native API v1，服务端负责同源代理、静态托管，以及配置文件的校验、保存与回滚。

## 目录

- `web/`：React 19 + TypeScript + Zustand + `react-resizable-panels`，样式与 todo-web 一致（等宽字体、黑白灰、细分割线）。
- `server/`：零依赖 Node 24 服务，托管 `web/dist`，把 `/api/*` 转发到 dae，在 `/console/*` 上编排配置写入，并限制非回环来源的写操作。

## 前置条件

dae 已安装并运行，且配置里打开了 native API：

```
api {
    enabled: true
    listen: '127.0.0.1:9527'
    allow_anonymous_loopback: true
}
```

api 段属于重启生效项，改完执行 `systemctl restart dae`。

## 开发

先启动服务端（默认 `0.0.0.0:8092`，转发到 `http://127.0.0.1:9527`）：

```sh
cd apps/dae-web
node server/src/server.ts
```

另开终端启动前端（`/api` 由 Vite 代理到 dae，并去掉 Origin 头）：

```sh
cd apps/dae-web/web
npm run dev
```

打开 http://localhost:5186 。`DAE_WEB_API` 可指定其它 dae 地址。

## 构建与运行

```sh
cd apps/dae-web/web && npm run build
cd ../.. && node server/src/server.ts
```

环境变量见 [`server/HTTP.md`](server/HTTP.md)。生产常驻用 systemd 用户服务 `dae-web.service`，默认监听 `0.0.0.0:8092`。

## 能做什么

概览、活跃连接、流历史、流量规则与 DNS 规则、DNS 解析日志与缓存、运行日志，以及选中条目后的路由回溯。dae 的记录只在进程内存中，本服务不落盘。

配置分区可以编辑 `DAE_CONFIG_PATH` 指向的文件：先由 dae 做 `full` 校验，再备份、以 sudo 写入、触发热加载，热加载失败自动回滚。配置的读取与写入只对本机开放，局域网只看到观测分区。文件属主是 root，运行用户需要它的免密 sudo 权限。
