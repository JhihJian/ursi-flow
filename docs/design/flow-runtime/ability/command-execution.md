# 命令执行

## 能力说明

命令节点执行已渲染的命令请求，返回退出码、标准输出与标准错误。`output: "variables"` 时，标准输出的 `{"variables": {...}}` 信封成为业务变量。

## 依赖说明

Flow Core 在准备待办时渲染 `command`、`args`、`stdin`、`cwd`，并提供 `readCommandVariables` 解析信封。引擎只依赖执行器的 `command(request)`，不关心进程如何启动。

## 启用与生命周期

Flow 含 `执行自定义命令` 节点时启用。宿主实现 `command` 端口：本地模式用子进程，参数中独立的 `scripts/...` 相对包根定位。退出码非 0 不改变路由，命令节点只有 `已执行` 一条结果边。
