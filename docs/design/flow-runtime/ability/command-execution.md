# Command Execution

## 能力说明
执行 Flow 的自定义命令并返回结构化 `CommandResult`。

## 依赖说明
依赖 `core/contracts` 的 `CommandExecutor`。具体进程、远程执行、取消和资源限制由 Integration 提供。

## 启用与生命周期
引用自定义命令节点时启用。Run 创建前预检，节点执行期间持有命令资源，完成、失败或取消后释放。
