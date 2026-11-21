# 工作包配方转换契约

## Python 输入与结果

`transform(item, resources)` 的 `item` 仅含 `id`、`title`、`description`、`category`、`status`。后两个字段取自生成开始时的工作项，分别表示工作类别与办理状态，取值见[工作清单契约](HTTP.md)。`resources[alias]` 包含 `serverId`、`uri` 和 `contents` 数组，数组里的每一项含 `uri`、可选 `mimeType` 和 `text` 或标准 Base64 `blob`。生成来源中的 `sha256` 取自该数组的紧凑 UTF-8 JSON，`readAt` 为 Unix 毫秒。

```python
def transform(item, resources):
    text = resources['feedback']['contents'][0]['text']
    return {'name': item['title'], 'files': [{'path': '材料/反馈.md', 'text': text}]}
```

转换使用 Linux 用户命名空间、`/usr/bin/bwrap`、系统 `/usr/bin/python3` 和 `libseccomp.so.2`，部署需支持 bwrap 的 `--disable-userns`。解释器以清空的环境和只读运行库启动，不挂载工作目录、用户家目录或 `/proc`。可信启动器预加载 `base64`、`collections`、`csv`、`datetime`、`hashlib`、`io`、`itertools`、`json`、`math`、`re` 等模块，然后安装内核系统调用白名单。此后仅保留管道 I/O、进程自身内存管理、计时和退出所需的调用。脚本在内存中处理材料，只能导入已加载的模块或无需读取文件的内建模块。内核拒绝打开文件、创建套接字和启动子进程。

| 限额 | 值 |
| --- | --- |
| 单次生成 | 45 秒，最多 32 个资源引用，脚本 64 KiB |
| 外部响应与输入快照 | 每个 MCP 响应 4 MiB，资源内容累计 4 MiB |
| Python | 地址空间 192 MiB，CPU 2 秒，含启动与管道读写的总时长 6 秒 |
| 生成文件 | 1 至 128 个，正文合计 4 MiB，输入输出 JSON 各 6 MiB |

包名最长 80 个字符，文件路径遵循虚拟目录规则。文件正文只接受 `text` 或 `blob` 之一。转换器在校验全部文件后交付结果，由调用方复核工作项修订并发布。

在具备上述隔离设施的主机上，可使用 `cargo test --manifest-path workbench/server/Cargo.toml --lib work::worklist::convert::tests -- --include-ignored` 连同真实隔离用例一起验收。
