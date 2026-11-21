# Server v2：工作清单、目录与定义

Server 的私有 `work/` 存储持有 v2 业务数据。工作清单回答「有哪些事要做」，工作包保存文件，资源与执行器目录则保存可按修订号查询的定义。Flow 包和运行历史归独立的 [v1 运行服务](SERVER-FLOW.md)管理。

## 从清单项到文件包

[工作清单](../../../workbench/server/src/work/worklist/SPEC.md)保存标题、说明、类别、状态和可选配方。保存配方时不读取外部资源。用户请求生成时，Server 读取[平台 MCP 服务](../../../workbench/server/src/work/mcp/PLATFORM.md)的授权资源，将材料快照交给隔离的 Python 转换器。校验文件并复核清单项修订后，Server 发布一个关联到该项的工作包。同一生成请求的重试返回原包。

[包记录](../../../workbench/server/src/work/patches/HTTP.md)保存名称和 `directoryId`，文件归[虚拟目录](../../../workbench/server/src/work/directories/HTTP.md)管理。工作包的当前归属可改，生成来源固定。删除清单项时只解除归属，文件和来源仍可查。配置包独立保存提示词、技能和 MCP 配置文件；这些文件与平台连接 MCP 服务的出站授权用途不同。

## 版本化定义

[资源与执行器目录](../../../workbench/server/src/work/catalog/HTTP.md)分别分配修订号。执行器发布时校验引用的提示词或技能修订，资源更新后旧执行器仍引用原版本。停用阻止新发布与新引用，历史修订仍可读取。发布定义不创建运行。执行目标、输入和制品的职责边界见[执行器设计](EXECUTOR-DESIGN.md)。

## 存储升级

旧派工记录不参与清单和包的归属关系。首次打开旧存储会不可逆地清除专属数据，范围与备份要求见[旧数据升级](../../../workbench/server/README.md#旧数据升级)。
