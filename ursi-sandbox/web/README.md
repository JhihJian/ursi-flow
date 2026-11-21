# 沙箱资源控制台

`/sandboxes` 提供 Gateway 实例管理。管理员可通过快速创建表单填写镜像、命令和资源，页面会自动组装不含端点字段的 SandboxSpec JSON；也可切换到 JSON 编辑直接提交完整规格。端点由 Gateway 注册表决定。创建后可在详情页启动、停止、选择保留数据或销毁数据重建，或确认删除实例，请求受理后页面轮询最终状态。页面按 Gateway capabilities 展示可用的重建方式。列表可按状态筛选。详情页以工作台为主，旁边的检查区可展开规格、端点快照和最近 200 行日志，窄屏下检查区位于工作台下方。重建和删除在「更多操作」中确认。刷新详情时，仍然有效的同代际连接会保留。

管理员从实例详情进入「网络观测」。启用和配对 [Observer](../observer/README.md) 后，可为运行且无待处理操作的实例开始采集。活动页每 2 秒更新已写报文数、PCAP 大小、丢包及最近一分钟的写入速率。离开页面不停止观测，保存记录链接即可在刷新或重建后打开同一记录。服务离线时保留最后快照，恢复后重新查询。

停止请求受理后，等待收尾，再选择分段。点「预览分段」可读取前 500 条完整 SLL2 记录，按地址、协议和方向筛选。列表保留文件中的记录顺序，显示相对本段首帧的时间、端点和协议摘要。选择一行可展开协议字段，并在 Hex/ASCII 中定位对应字节；点击字节则定位到最具体的已解析字段。字节窗每条最多显示前 512 B。点「下载完整分段」可取回未经显示筛选的 PCAP。`interrupted` 的末段可能不完整。状态、预览和下载均限管理员。自建同源代理须对观测 GET 和 POST 再次校验管理员身份，并按二进制流转发分段。技术细节见[页面设计](../../docs/design/ursi-sandbox/NETWORK-OBSERVATION.md)。

## 构建与启动

在本目录使用 Node.js 22.16 或更高版本。运行 `npm start` 前，按下文配置 Gateway 及 Web 身份：

```bash
npm ci
npm run build
npm start
```

打开 `http://localhost:4180/sandboxes`。内置服务的交付文件包括 `dist/`、`server.mjs`、`workbench.mjs` 和 npm 清单。安装运行依赖后，使用 `node server.mjs` 启动。`PORT` 可调整监听端口。

## 静态交付

页面采用 React 19、TypeScript、React Router、Tailwind CSS 3、Vite 和 shadcn/ui 组件模式。`src/shared/ui/` 提供基于 Radix UI、CVA 和 Tailwind 封装的界面组件，包括表格、标签页、下拉菜单、开关、确认对话框和折叠区。工作台的工具栏与独立显示区参考 Grasp 的沙箱视图，终端和远程画面继续由 xterm.js 和 noVNC 渲染。`npm run build` 先做类型检查，再将 HTML、CSS 和脚本输出到 `dist/`。资源路径相对于入口目录；详情使用 hash 路由，直接打开或刷新均无需配置 SPA 回退。

`src/tokens.css` 保存 Workbench 主题变量的独立副本；同源时读取其 `ursi-flow:theme` 和 `ursi-flow:palette` 偏好。构建不依赖 Workbench 源码。将静态资源部署到子目录（例如 `/apps/sandbox/`）时，由同源鉴权代理在该目录提供 `console-config.json`（`{"mode":"gateway"}`）及 Gateway API。管理身份的配置额外返回 `manage:true`，代理须按身份及方法再次鉴权。Gateway 管理密钥只配置在代理端。

## 配置 Gateway 与 Web 身份

先启动 [Gateway](../gateway/README.md)。为控制台进程设置以下环境变量，重新运行 `npm start`，浏览器使用 `admin` 或 `viewer` 登录。至少配置一种 Web 身份。

| 变量 | 用途 |
| --- | --- |
| `URSI_GATEWAY_URL` | 受信的 Gateway 地址，例如 `http://127.0.0.1:8899` |
| `URSI_GATEWAY_KEY` | 已配置给该 Gateway 的管理密钥，仅保存在服务端 |
| `URSI_WEB_PASSWORD` | 可选。`viewer` 只读密码，至少 16 个字符 |
| `URSI_WEB_ADMIN_PASSWORD` | 可选。`admin` 管理密码，至少 16 个字符，必须与查看密码和 Gateway 密钥不同 |
| `URSI_WEB_TLS_CERT` / `URSI_WEB_TLS_KEY` | 直接对外提供 HTTPS 时使用的证书和私钥文件路径 |
| `URSI_WEB_ORIGIN` | 经反向代理访问时的完整来源，例如 `https://sandbox.example.org`。代理须保留 Host 和 WebSocket Upgrade |
| `URSI_WEB_SSH_KEY_FILE` | Web 服务专用 SSH 私钥文件。公钥须由管理员加入实例配置的 `authorized_keys` |
| `URSI_WEB_SSH_HOST_PINS_FILE` | 可信 SSH 主机指纹 JSON 文件。键是沙箱 ID，值是 `ssh-keygen -lf` 输出中的 `SHA256:…` 指纹 |

查看者可读取整个命名空间的规格及日志。管理员可操作整个命名空间。无 TLS 证书时只监听 `127.0.0.1`，可配合 HTTPS 反向代理或 SSH 端口转发；配置证书后监听 `0.0.0.0`。HTTP Basic 凭据需要受保护的传输链路。对外提供访问时，在 HTTPS 反向代理后运行，并限制控制台端口的直接访问。未配置 Gateway 或 Web 身份时服务拒绝启动。查询失败时页面显示错误并提供重试。

### 端点工作台

管理员从沙箱详情切换终端、IDE、桌面或应用预览。启用 Gateway 隧道（`URSI_GATEWAY_TUNNEL=true`），并使用支持代际约束的 Gateway。桌面、IDE 和预览还需部署 [browser 镜像与 bundle](../builder/README.md)，并从 HTTPS 或 localhost 访问 Web。

| 入口 | 组件与条件 |
| --- | --- |
| 终端 | xterm.js + SSH2。需要就绪的 `ssh` 端点及该实例的主机指纹 |
| 桌面 | noVNC + websockify。需要就绪的 `desktop` 端点，默认只看画面，可开启键鼠控制 |
| IDE | code-server 在沙箱 Chromium 内打开，通过 noVNC 操作。需要 SSH 和桌面，且 `ide` 端点已就绪 |
| 应用预览 | 从注册表选择已就绪的 HTTP 端点。应用需在沙箱内通过 `127.0.0.1:<port>` 访问。与 IDE 共用 SSH 和桌面连接条件 |

SSH 指纹由管理员通过可信的宿主机管理通道获取，例如 Docker 沙箱中的 `ssh-keygen -lf /run/ursi/sshd/host_ed25519.pub`。重建后重新核对指纹并重启 Web 服务加载配置。私钥和指纹文件存放在仓库外。CDP 只监听沙箱回环地址。沙箱端口不发布到宿主机。生产部署应隔离不互信的容器网络，阻止同网段容器绕过 Gateway 直连 code-server 和 websockify。

### CLI 对照

`gateway list/create/status/start/stop/rebuild/delete/endpoints` 分别对应实例列表、创建规格、详情状态、生命周期操作、两种重建、删除和服务端点。端点读取自 Gateway 的实例快照。SSH 命令、SFTP 工作区访问和 ACP 会话也可通过独立身份使用 [CLI](../client/README.md)。Web 页面不接收 Gateway key，也不拼接端点地址。

## 测试

```bash
npm test
npx playwright install chromium
npm run test:e2e
```

`node tests/live-observation.mjs` 验证真实 Chromium、Web 代理、Gateway 和 Observer 的完整链路。先在 `ursi-sandbox/` 构建 Gateway 和 Observer 的 debug 二进制，准备 [Docker 验收镜像](../observer/ACCEPTANCE.md#复现)，再从 `web/` 以普通用户运行 `npm run build` 和该脚本。Linux 测试宿主需允许 `sudo -n` 启动 Python 夹具。夹具核对两个临时沙箱和宿主的网络命名空间各异，再开始观测；浏览器在方向筛选后下载的文件须与 Gateway 原始分段的大小和 SHA-256 一致。脚本退出时清理本轮资源。

`tests/live-management.mjs` 会在专用 Docker 命名空间实际创建、启停并删除 `alpine:3.22` 实例。设置 `URSI_TEST_WEB_URL` 为管理页、`URSI_TEST_ADMIN_FILE` 为管理密码文件后执行 `node tests/live-management.mjs`。使用自签证书时，`URSI_TEST_CERT_PIN` 指定经核实的证书 SPKI SHA-256（Base64）。

`node tests/live-workbench.mjs` 使用相同的地址和管理员密码配置。将 `URSI_TEST_SANDBOX_ID` 指向专用的就绪 browser 实例，可验证终端命令回显、桌面画面和 IDE。指定 `URSI_TEST_APP_ENDPOINT` 后还会验证该已注册应用的预览画面。
