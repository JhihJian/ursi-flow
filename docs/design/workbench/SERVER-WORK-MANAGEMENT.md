# Server v2：业务工作包与执行器平台的边界

Workbench 管理工作清单、生成器、工作包和业务目录。独立的[执行器平台](../../../executor-platform/server/SPEC.md)管理配置包、资源与执行器修订、后端绑定、执行尝试和只读制品。Flow 包、运行配置和节点历史归 [Flow Runtime](SERVER-FLOW.md)。三个服务各自写入私有存储，通过引用和 API 交换数据，不共享目录根。

## 从清单项到业务文件

[工作清单](../../../workbench/server/src/work/worklist/SPEC.md)保存标题、说明、类别和状态，只承载事项信息。生成文件包时，[工作包生成器](../../../workbench/server/src/work/generation/SPEC.md)读取[已登记 MCP 服务](../../../workbench/server/src/work/mcp/PLATFORM.md)的授权资源，将材料快照交给隔离的 Python 转换器；校验文件并确认事项仍存在后，发布一个归属该事项的工作包。同一生成请求的重试返回原包。

[工作包记录](../../../workbench/server/src/work/patches/HTTP.md)通过 `directoryId` 标识本地业务目录。工作包的当前归属可改，生成来源固定。删除清单项时只解除归属，文件和来源仍可查。工作包可按 ID 引用平台配置包，创建时须经平台核验。本地工作包目录只保存业务文件，配置包中的提示词、技能和 MCP 设置由平台管理，与 Workbench 获取业务材料所需的 MCP 凭据分开。

## 从工作包到平台制品

平台管理员在独立入口管理配置包和后端，试跑草稿、发布或停用[资源与执行器定义](../../../workbench/server/src/work/catalog/HTTP.md)。发布时平台冻结执行配置。Workbench 只读取选版所需元数据，用固定的 `executorRef: {id, revision}`、指令和输入文件快照提交尝试。工作包 ID 由 Workbench 本地解析，不交给平台打开目录。Flow 中的委派由 Runtime 使用自己的角色执行。

平台按角色隔离尝试。Workbench 用原尝试 ID 查询或取消，终态响应中的 `artifactDirectoryId` 为 `platform-artifact-{attemptId}`。Workbench 按尝试确认平台已发布制品，再代理目录、文件树和文件正文的只读请求。普通目录 ID 只在业务库解析，即使两侧恰有相同 ID，也不会跨库读写。Workbench 的目录列表不枚举平台配置或制品。

## 存储升级与切换

首次打开旧 `work/` 前应停服并完整备份，包括 `work.json` 与目录文件。持锁清理旧派工单、模板和尝试级配置快照是不可逆的业务库升级，仅清理专属且已登记的目录。它不把旧配置包、执行器修订、后端绑定或历史尝试搬入平台。

旧库中 `configPatches` 指向的配置目录和 `executorAttempts` 指向的制品目录仍在磁盘上，但不列为业务目录，按旧 ID 读写均返回 404。业务目录按原状态保留，包括只读的生成器结果。平台须使用独立私有根；启用已有业务引用前，先在平台核对配置包 ID、执行器修订和冻结快照。备份与恢复步骤见[部署说明](../../../workbench/server/README.md#旧数据升级)。
