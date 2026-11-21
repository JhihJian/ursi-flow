# Child Flow

## 能力说明
启动、关联和恢复子 Flow Run，并保留父子 Run 与 NodeRun 关系。

## 依赖说明
依赖 `core/contracts` 的 FlowPackage、RunStore 和 Child Flow Executor。子 Flow 必须共享同一个事实 Store。

## 启用与生命周期
Flow 包含 `执行Flow` 节点时启用。子 Run 创建、执行、恢复和结束都由父节点动作生命周期管理。
