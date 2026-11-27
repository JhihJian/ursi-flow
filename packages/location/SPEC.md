---
parent: ../../SPEC.md
---

# 位置契约

## 功能意图

`@ursi/location` 定义工作目录的身份。用户的工作单元是「哪台机器的哪个目录」，过去这个事实在 fs、pi、ssh、todo 里各存一份、互不相认。现在统一成一个 URI：

```
file:///abs/path           本机（工作台服务所在机器）
ssh://<设备名>/abs/path    远程，设备名是 ssh-web 的连接名
```

形态借自 RFC 3986，与 git、GVfs、sshfs 一致。但不经 URL 解析器：OpenSSH 的 Host 别名大小写敏感，而 URL 解析器会把主机名小写化，所以自己按 `://` 切。路径段用 percent-encoding，空格、中文、`#`、`%` 全部可逆。

这是契约，不是服务：没有进程、没有数据库，各模块照旧独立部署。包里只有纯函数，前后端都能用。

## 关键功能与验收

### 解析与构造

`parse` 接受 URI 或本机路径简写（`/abs`、`~`、`~/x`），返回 `{ uri, scheme, device, path }`。`build` 是它的逆。`uri` 是唯一事实源，其余字段是解析结果。

#### 验收

- `file:///a/b`、`/a/b`、`file://localhost/a/b` 都解析为本机位置 `/a/b`。
- `ssh://nm105/srv/proj` 解析出设备 `nm105`、路径 `/srv/proj`。设备名大小写原样保留，`ssh://NM105/x` 与 `ssh://nm105/x` 是两个位置。
- 设备名只允许 `[A-Za-z0-9][A-Za-z0-9._-]*`。`user@host`、`host:port` 报 `bad_device`，用户与端口归 ssh-web 的连接命令表达。
- 路径段 percent-decode，`%20`、`%E4%B8%AD%E6%96%87`、`%23`、`%25` 全部还原。编码非法报 `invalid_uri`。
- 规范化只做三件事：以 `/` 开头，折叠连续斜杠，去尾斜杠。不折叠 `..`，不做 Unicode 归一化，越界由各 provider 的 realpath 防护负责。
- `smb://` 等其它 scheme 报 `unsupported_scheme`。相对路径报 `relative_path`。`~` 需要调用方给 `home`。

### 派生

`parentOf`、`childOf`、`basename`、`crumbs`、`pathSegmentsOf` 从一个位置推出相邻位置，保留 scheme 与设备。`isWithin` 判断同设备下的包含关系。

#### 验收

- `parentOf` 在根目录返回 `null`，其余返回上级并保留设备。
- `childOf` 拒绝 `..`、`.`、空串、含 `/` 与 NUL 的名称。
- `crumbs` 每段带自己的位置，根目录为空数组。

### 持久化键

`keyOf` 返回规范 URI 的 sha256 前 16 个 hex。算法与 fs-web、pi-web 现有的 realpath 哈希一致，跨进程稳定。

#### 验收

- 同一 URI 两次求键一致。设备名大小写不同得到不同的键。
- 键是 16 位小写 hex。

### 共享测试向量

`vectors.json` 是契约的权威样例。TS 实现跑全部字段。ssh-web 的 Rust 侧用 `include_str!` 读同一份文件，至少断言 `parse` 的 `scheme`、`device`、`path` 三字段。

#### 验收

- `npm run test:location` 全绿。
- 改 `vectors.json` 必须两边同时通过。

## 边界

- URI 是身份，不是存储键。存储用 `keyOf`。
- URI 不做 HTTP 传输层。fs-web 的路径传输继续用 `segments` 数组。
- 不做设备发现。设备清单归 ssh-web，由组合根注入。
- 不做 realpath、不探活、不发请求。这些归各模块的服务端。
- 不做 Unicode NFC/NFD 归一化，不处理大小写不敏感文件系统的身份重复。文件系统给什么就是什么。

## 归属

- 父级：[ursi-flow](../../SPEC.md)。
- 使用方：`@ursi/directory-picker`、fs-web 服务端与前端、pi-web 服务端（本机路径规范化）。ssh-web 的 Rust 侧只做最小解析。
- 设计背景与取舍见 [ARCHITECHTURE.md](../../ARCHITECHTURE.md) 的「位置契约」一节。
