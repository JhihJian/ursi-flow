# Parallel Execution

## 能力说明
管理并行分支、分支输入隔离、汇合和 ParallelRound 状态。

## 依赖说明
依赖 `core/contracts` 的 ParallelRound、分支事实和 Parallel Executor。具体并发调度由宿主 Integration 提供。

## 启用与生命周期
Flow 声明并行分支时启用。创建 round 后启动分支，等待全部分支结束，再提交汇合事实并释放分支资源。
