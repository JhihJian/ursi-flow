# 迁移执行器管理资产

停止旧 Workbench，先核实所有尝试均已结束并收齐制品，再备份整个旧数据目录。用服务账户在 Linux 上运行以下命令，目标必须尚不存在，父目录须归当前账户或 root 所有且不允许组或其他用户写入。

```sh
python3 executor-platform/migration/migrate.py /absolute/work /absolute/platform
python3 executor-platform/migration/migrate.py /absolute/work /absolute/platform --apply
```

第一条只读取并验证，第二条在同一文件系统内先暂存，再原子发布。检查提示词、Skill 和配置附件中是否存有业务密钥，脚本不能识别任意文本中的所有凭据。它仅从旧库选取配置包及其目录、资源、执行器修订、冻结快照与绑定。后端程序和策略由管理员在新服务配置，历史绑定的私有绝对路径须保持可用。

工作清单、工作包、旧运行和旧制品留在源库；已终止尝试的 ID 在新库中保留为不可重新认领的标记，不能用平台 API 查回这些旧制品。遇到未终止尝试、共享目录、已存在目标或无法识别的管理记录时停止，不修改源库。保留旧库离线备份供历史审计。

将目标设为 `URSI_EXECUTOR_PLATFORM_DATA_DIR` 后启动平台，核对旧修订、重新检查后端，用测试材料运行一个已发布执行器。确认成功后再切换消费者的 URL 与令牌。回滚前停止写入并保存两侧的新数据；源库不会自动合并切换后的管理变更。
