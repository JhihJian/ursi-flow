//! 角色服务：连接校验、引用登记补偿与可冻结定义交付。
//!
//! 一致性归属（DESIGN「一致性归属」）：角色写入归 roles 自管事务；连接
//! 引用登记是 connections 的外部状态，无法共享 SQLite 事务。采用文档化的
//! 顺序性补偿语义：
//!
//! 1. 校验角色 → 经网关确认连接存在且能力匹配（只读查询）；
//! 2. `register_ref`（网关，幂等）；
//! 3. 本地事务写入角色；本地写入失败时补偿解除本次登记再返回错误，
//!    本地保持原值；
//! 4. 更换连接时旧引用解除失败不回滚已提交的角色（登记幂等可重试解除），
//!    报告错误供调用方重试。
//!
//! 恢复顺序保证：任何失败路径上，本地存储要么保持原值，要么不含本次
//! 写入；连接登记要么指向旧连接，要么多出一条可幂等解除的登记，不产生
//! 无法解释的中间态。
//!
//! 交付：[`RoleService::export_freezable`] 返回完整可冻结定义（含全部
//! skills 文件字节与连接凭据引用，不含凭据明文），返回值是克隆，后续
//! 编辑原角色不影响已交付值。

use super::error::RolesError;
use super::gateway::ConnectionGateway;
use super::model::RoleDefinition;
use super::store::RoleStore;

/// 角色服务。
pub struct RoleService<S: ConnectionGateway> {
    store: RoleStore,
    gateway: S,
}

impl<S: ConnectionGateway> RoleService<S> {
    pub fn new(store: RoleStore, gateway: S) -> Self {
        Self { store, gateway }
    }

    /// 存储句柄（workflows 编排事务内登记入口等场景使用）。
    pub fn store(&self) -> &RoleStore {
        &self.store
    }

    /// 保存角色：校验 → 连接存在性与能力匹配 → 登记新连接引用 →
    /// 本地写入 → 解除旧连接引用（更换连接时）。
    pub async fn save(&self, def: &RoleDefinition) -> Result<(), RolesError> {
        def.validate().map_err(RolesError::from)?;
        let old = self.store.get(&def.base.id)?;
        let old_conn = old.as_ref().map(|d| d.connection_id.as_str()).map(str::to_string);
        self.check_connection(def).await?;
        // 先登记后提交：登记幂等，本地失败时补偿解除本次登记。
        self.gateway
            .register_ref(&def.connection_id, &def.base.id)
            .await
            .map_err(RolesError::from)?;
        if let Err(e) = self.store.save(def) {
            // 本地写入失败：补偿解除本次登记，恢复引用状态。
            let _ = self
                .gateway
                .unregister_ref(&def.connection_id, &def.base.id)
                .await;
            return Err(e);
        }
        // 更换连接：解除旧引用。解除失败不回滚已提交的角色（旧登记残留
        // 仅多占一条引用），报告错误供调用方重试。
        if let Some(old_conn) = old_conn {
            if old_conn != def.connection_id {
                if let Err(e) = self.gateway.unregister_ref(&old_conn, &def.base.id).await {
                    return Err(RolesError::Gateway(format!(
                        "角色已保存，但旧连接 {old_conn} 的引用解除失败：{e}"
                    )));
                }
            }
        }
        Ok(())
    }

    /// 校验连接存在且能力匹配。连接缺失与能力不匹配返回可定位错误；
    /// 能力描述不可用视为「能力未知」，同样拒绝保存（角色可执行性必须
    /// 确认），错误文本区分于确定不匹配。
    async fn check_connection(&self, def: &RoleDefinition) -> Result<(), RolesError> {
        let conn = self
            .gateway
            .get(&def.connection_id)
            .await
            .map_err(RolesError::from)?
            .ok_or_else(|| RolesError::Connection(format!("连接 {} 不存在", def.connection_id)))?;
        let caps = self
            .gateway
            .describe_capabilities()
            .await
            .map_err(|e| {
                RolesError::Connection(format!("能力描述不可用，无法确认连接可用性：{e}"))
            })?;
        if !caps.supported_service_types.contains(&conn.service_type) {
            return Err(RolesError::Connection(format!(
                "连接 {} 的服务类型 {} 不在执行器支持集合内",
                def.connection_id,
                conn.service_type
            )));
        }
        Ok(())
    }

    /// 读取完整定义。不存在返回 `Ok(None)`。
    pub async fn get(&self, id: &str) -> Result<Option<RoleDefinition>, RolesError> {
        self.store.get(id)
    }

    /// 列出全部定义。
    pub async fn list(&self) -> Result<Vec<RoleDefinition>, RolesError> {
        self.store.list()
    }

    /// 复制角色为新标识：深拷贝全部配置与文件并保留连接引用；复制同样
    /// 经过连接校验与登记（新副本是对同一连接的独立引用）。复制中内容
    /// 或写入失败则无残缺副本（查询不到）。
    pub async fn copy(&self, id: &str) -> Result<RoleDefinition, RolesError> {
        let mut def = self
            .store
            .get(id)?
            .ok_or_else(|| RolesError::NotFound(id.to_string()))?;
        let new_id = format!("role_{}", uuid::Uuid::new_v4());
        def.base.id = new_id.clone();
        self.save(&def).await?;
        Ok(self.store.get(&new_id)?.expect("刚写入的副本必须可读"))
    }

    /// 删除角色：无引用可删，被流程引用返回 `Conflict` 并保留完整定义。
    /// 删除成功后解除对连接的引用登记；解除失败报告错误（角色已删除，
    /// 登记幂等可重试）。
    pub async fn delete(&self, id: &str) -> Result<(), RolesError> {
        let removed = self.store.delete(id)?;
        if let Err(e) = self
            .gateway
            .unregister_ref(&removed.connection_id, id)
            .await
        {
            return Err(RolesError::Gateway(format!(
                "角色已删除，但连接 {} 的引用解除失败：{e}",
                removed.connection_id
            )));
        }
        Ok(())
    }

    /// 流程引用登记与解除（转发存储层；事务内版本经 store 句柄使用，
    /// 供 workflows 在流程定义保存的同一事务中调用）。
    pub fn register_workflow_ref(&self, role_id: &str, wf_id: &str) -> Result<(), RolesError> {
        self.store.register_workflow_ref(role_id, wf_id)
    }

    pub fn unregister_workflow_ref(&self, role_id: &str, wf_id: &str) -> Result<(), RolesError> {
        self.store.unregister_workflow_ref(role_id, wf_id)
    }

    /// 定义交付：完整可冻结定义（全部 skills 文件字节 + MCP 配置 + 连接
    /// 凭据引用）。克隆语义：读取后编辑原角色不影响已交付值。
    /// 引用的连接已不存在时返回错误（配置不一致）。
    pub async fn export_freezable(
        &self,
        role_id: &str,
    ) -> Result<FreezableRoleDefinition, RolesError> {
        let def = self
            .store
            .get(role_id)?
            .ok_or_else(|| RolesError::NotFound(role_id.to_string()))?;
        // 旧角色可能在 ACP 能力边界生效前写入；先校验完整聚合再投影到快照。
        def.validate().map_err(RolesError::from)?;
        let connection = self
            .gateway
            .get(&def.connection_id)
            .await
            .map_err(RolesError::from)?
            .ok_or_else(|| {
                RolesError::Connection(format!("连接 {} 不存在，无法交付", def.connection_id))
            })?;
        Ok(FreezableRoleDefinition { definition: def, connection })
    }
}

/// 可冻结的完整角色定义：角色聚合 + 连接可冻结配置（含凭据引用）。
#[derive(Debug, Clone, PartialEq)]
pub struct FreezableRoleDefinition {
    pub definition: RoleDefinition,
    pub connection: crate::connections::FreezableConfig,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{FreezableConfig, ServiceType};
    use crate::roles::gateway::{ConnectionCapabilities, GatewayError};
    use crate::roles::skills::{SkillFile, SkillPackage, SKILL_ENTRY};
    use crate::storage::{ContentStore, Database};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 连接网关替身：可配置存在性、能力集合、登记/解除计数与失败注入。
    /// RoleService 持有它直至测试结束，调用计数经 Arc 在断言处读取。
    struct FakeGateway {
        connections: std::collections::BTreeMap<String, ServiceType>,
        supported: Vec<ServiceType>,
        describe_ok: bool,
        register_calls: AtomicUsize,
        unregister_calls: AtomicUsize,
        fail_unregister: bool,
    }

    impl FakeGateway {
        fn with_types(types: &[ServiceType]) -> Self {
            let mut connections = std::collections::BTreeMap::new();
            connections.insert("conn_ok".to_string(), ServiceType::OpenAiCompatible);
            connections.insert("conn_bad".to_string(), ServiceType::Anthropic);
            Self {
                connections,
                supported: types.to_vec(),
                describe_ok: true,
                register_calls: AtomicUsize::new(0),
                unregister_calls: AtomicUsize::new(0),
                fail_unregister: false,
            }
        }
    }

    #[async_trait::async_trait]
    impl ConnectionGateway for FakeGateway {
        async fn get(&self, id: &str) -> Result<Option<FreezableConfig>, GatewayError> {
            Ok(self.connections.get(id).map(|st| FreezableConfig {
                id: id.to_string(),
                name: "test".into(),
                service_type: st.clone(),
                endpoint: "https://api.example.com".into(),
                credential_ref: "vault://keys/test".into(),
                created_at: None,
            }))
        }

        async fn register_ref(&self, _conn_id: &str, _role_id: &str) -> Result<(), GatewayError> {
            self.register_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn unregister_ref(&self, _conn_id: &str, _role_id: &str) -> Result<(), GatewayError> {
            if self.fail_unregister {
                return Err(GatewayError::Failed("解除被拒绝".into()));
            }
            self.unregister_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn describe_capabilities(&self) -> Result<ConnectionCapabilities, GatewayError> {
            if !self.describe_ok {
                return Err(GatewayError::Failed("能力描述接口不可用".into()));
            }
            Ok(ConnectionCapabilities { supported_service_types: self.supported.clone() })
        }
    }

    #[async_trait::async_trait]
    impl ConnectionGateway for Arc<FakeGateway> {
        async fn get(&self, id: &str) -> Result<Option<FreezableConfig>, GatewayError> {
            (**self).get(id).await
        }

        async fn register_ref(&self, conn_id: &str, role_id: &str) -> Result<(), GatewayError> {
            (**self).register_ref(conn_id, role_id).await
        }

        async fn unregister_ref(&self, conn_id: &str, role_id: &str) -> Result<(), GatewayError> {
            (**self).unregister_ref(conn_id, role_id).await
        }

        async fn describe_capabilities(&self) -> Result<ConnectionCapabilities, GatewayError> {
            (**self).describe_capabilities().await
        }
    }

    type TestService = RoleService<Arc<FakeGateway>>;

    fn service(gateway: FakeGateway) -> (TestService, Arc<FakeGateway>, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("roles.db").to_string_lossy().to_string();
        let content_root = dir.path().join("content");
        let root = content_root.clone();
        std::mem::forget(dir);
        let db = Database::open(&db_path, crate::roles::store::migrations()).unwrap();
        let content = ContentStore::open(&content_root).unwrap();
        let gw = Arc::new(gateway);
        (RoleService::new(RoleStore::new(db, content), Arc::clone(&gw)), gw, root)
    }

    fn def(id: &str, conn: &str) -> RoleDefinition {
        RoleDefinition {
            base: crate::roles::model::test_base(id),
            skill_package: SkillPackage::new(vec![
                SkillFile::new(SKILL_ENTRY, "# 说明"),
                SkillFile::new("scripts/run.sh", "echo ok"),
            ])
            .unwrap(),
            mcp_servers_config: vec![],
            connection_id: conn.into(),
            executor_kind: Some(ursi_domain::ExecutorKind::Mock),
        }
    }

    /// SPEC「模型连接选择」：存在且能力匹配的连接保存成功，详情返回
    /// 连接标识与模型选择。
    #[tokio::test]
    async fn 匹配连接保存成功() {
        let (svc, _gw, _root) = service(FakeGateway::with_types(&[ServiceType::OpenAiCompatible]));
        let d = def("r1", "conn_ok");
        svc.save(&d).await.unwrap();
        let got = svc.get("r1").await.unwrap().unwrap();
        assert_eq!(got.connection_id, "conn_ok");
        assert_eq!(got.base.model.as_deref(), Some("claude-sonnet"));
    }

    /// SPEC「模型连接选择」：连接缺失或明确不支持返回可定位原因，角色
    /// 修改整体回滚（原定义不变、无残留登记）。
    #[tokio::test]
    async fn 连接缺失或不匹配整体失败() {
        let gw = FakeGateway::with_types(&[ServiceType::OpenAiCompatible]);
        let (svc, gw, _root) = service(gw);
        // 新建：连接不存在。
        let err = svc.save(&def("r1", "conn_missing")).await.unwrap_err();
        assert!(err.to_string().contains("conn_missing"), "实际：{err}");
        assert!(svc.get("r1").await.unwrap().is_none(), "失败不得产生角色");
        assert_eq!(gw.register_calls.load(Ordering::SeqCst), 0, "缺失连接不得登记");

        // 已存在角色的修改：连接不匹配 → 整体回滚保留原值。
        svc.save(&def("r2", "conn_ok")).await.unwrap();
        let before = svc.get("r2").await.unwrap().unwrap();
        let mut bad = def("r2", "conn_bad");
        bad.base.prompt = "不该被保存".into();
        let err = svc.save(&bad).await.unwrap_err();
        assert!(err.to_string().contains("conn_bad"), "错误应可定位连接：{err}");
        assert_eq!(svc.get("r2").await.unwrap().unwrap(), before);
    }

    /// SPEC「模型连接选择」：能力描述不可用时保存被拒绝（能力未知 ≠
    /// 确认可用），错误文本与确定不匹配可区分。
    #[tokio::test]
    async fn 能力未知拒绝保存() {
        let mut gw = FakeGateway::with_types(&[ServiceType::OpenAiCompatible]);
        gw.describe_ok = false;
        let (svc, _gw, _root) = service(gw);
        let err = svc.save(&def("r1", "conn_ok")).await.unwrap_err();
        assert!(err.to_string().contains("能力描述不可用"), "实际：{err}");
    }

    /// SPEC「模型连接选择」/「角色复制与定义交付」：读取和导出角色定义时，
    /// DTO、Debug 及可冻结配置均不含凭据明文标记（密钥值从不进入本域，
    /// 本测试用标记值扫描一切交付输出）。
    #[tokio::test]
    async fn 交付路径无凭据明文标记() {
        const SECRET: &str = "sk-LIVE-ROLES-MARKER";
        let (svc, _gw, _root) = service(FakeGateway::with_types(&[ServiceType::OpenAiCompatible]));
        let d = def("r1", "conn_ok");
        svc.save(&d).await.unwrap();
        let got = svc.get("r1").await.unwrap().unwrap();
        assert!(!format!("{got:?}").contains(SECRET));
        let exported = svc.export_freezable("r1").await.unwrap();
        assert!(!format!("{exported:?}").contains(SECRET), "导出泄漏了凭据明文");
        assert_eq!(exported.connection.credential_ref, "vault://keys/test");
        // 序列化形态：凭据字段只含引用（连接可冻结配置的 JSON 形态）。
        let json = serde_json::to_string(&exported.connection).unwrap();
        assert!(json.contains("vault://keys/test"), "冻结配置含凭据引用");
        assert!(!json.contains(SECRET));
        assert!(!json.contains("sk-LIVE"), "交付路径不得出现密钥形态值：{json}");
    }

    /// SPEC「模型连接选择」：更换连接时旧引用解除、新引用登记；校验失败
    /// 前置（非法定义不产生任何登记调用）。
    #[tokio::test]
    async fn 更换连接登记与解除() {
        let mut gw = FakeGateway::with_types(&[ServiceType::OpenAiCompatible, ServiceType::Anthropic]);
        gw.connections.insert("conn_b".to_string(), ServiceType::Anthropic);
        let (svc, gw, _root) = service(gw);
        let d = def("r1", "conn_ok");
        svc.save(&d).await.unwrap();
        assert_eq!(gw.register_calls.load(Ordering::SeqCst), 1);

        // 更换连接：登记新连接 + 解除旧连接。
        let mut moved = def("r1", "conn_b");
        moved.base.prompt = "换连接后".into();
        svc.save(&moved).await.unwrap();
        assert_eq!(gw.register_calls.load(Ordering::SeqCst), 2);
        assert_eq!(gw.unregister_calls.load(Ordering::SeqCst), 1);

        // 校验前置：非法定义在登记前被拦截。
        let mut invalid = def("r9", "conn_ok");
        invalid.connection_id = "  ".into();
        assert!(svc.save(&invalid).await.is_err());
        assert_eq!(gw.register_calls.load(Ordering::SeqCst), 2);
    }

    /// SPEC「模型连接选择」/「引用登记与删除约束」：本地写入失败时补偿
    /// 解除本次登记（先登记后提交、失败回滚本地的顺序补偿语义）。
    #[tokio::test]
    async fn 本地写入失败补偿解除登记() {
        let gw = FakeGateway::with_types(&[ServiceType::OpenAiCompatible]);
        let (svc, gw, _root) = service(gw);
        // 让本地写入失败：内容根目录放置与包内首段同名的符号链接。
        svc.save(&def("r1", "conn_ok")).await.unwrap();
        let before_regs = gw.register_calls.load(Ordering::SeqCst);
        std::os::unix::fs::symlink("/etc", _root.join("scripts")).unwrap();
        let mut bad = def("r1", "conn_ok");
        bad.skill_package = SkillPackage::new(vec![
            SkillFile::new(SKILL_ENTRY, "# 新入口"),
            SkillFile::new("scripts/evil.txt", "逃逸尝试"),
        ])
        .unwrap();
        let err = svc.save(&bad).await.unwrap_err();
        assert!(
            matches!(err, RolesError::Validation(_)),
            "symlink 逃逸应归为校验错误：{err:?}"
        );
        // 补偿：本次登记已被解除（登记 1 次 + 补偿解除 1 次）。
        assert_eq!(
            gw.register_calls.load(Ordering::SeqCst),
            before_regs + 1,
            "登记发生在本地写入前"
        );
        assert_eq!(gw.unregister_calls.load(Ordering::SeqCst), 1, "失败后补偿解除本次登记");
    }

    /// SPEC「角色复制与定义交付」：复制生成独立标识、配置等价；修改副本
    /// 不影响源；导出交付后编辑原角色不影响已交付值。
    #[tokio::test]
    async fn 复制与交付隔离() {
        let (svc, _gw, _root) = service(FakeGateway::with_types(&[ServiceType::OpenAiCompatible]));
        let src = def("r1", "conn_ok");
        svc.save(&src).await.unwrap();
        let copy = svc.copy("r1").await.unwrap();
        assert_ne!(copy.base.id, "r1");
        assert_eq!(copy.base.prompt, src.base.prompt);
        assert_eq!(copy.skill_package, src.skill_package);
        assert_eq!(copy.connection_id, "conn_ok", "复制保留连接引用");

        // 修改副本不影响源。
        let mut edited = copy.clone();
        edited.base.prompt = "副本提示词".into();
        edited.skill_package =
            SkillPackage::new(vec![SkillFile::new(SKILL_ENTRY, "# 副本")]).unwrap();
        svc.save(&edited).await.unwrap();
        let src_after = svc.get("r1").await.unwrap().unwrap();
        assert_eq!(src_after.base.prompt, "严格评审");
        assert_eq!(
            src_after.skill_package.file("scripts/run.sh").unwrap().bytes,
            b"echo ok"
        );

        // 交付后编辑原角色不影响已交付值。
        let frozen = svc.export_freezable("r1").await.unwrap();
        let mut changed = src_after.clone();
        changed.base.prompt = "交付后修改".into();
        changed.skill_package =
            SkillPackage::new(vec![SkillFile::new(SKILL_ENTRY, "# 改后")]).unwrap();
        svc.save(&changed).await.unwrap();
        assert_eq!(frozen.definition.base.prompt, "严格评审");
        assert_eq!(
            frozen.definition.skill_package.file("scripts/run.sh").unwrap().bytes,
            b"echo ok",
            "已交付内容对象不被后续编辑改写"
        );
    }

    /// SPEC「角色复制与定义交付」：复制过程中内容保存失败时，查询不到
    /// 缺少文件的副本。
    #[tokio::test]
    async fn 复制失败无残缺副本() {
        let (svc, _gw, _root) = service(FakeGateway::with_types(&[ServiceType::OpenAiCompatible]));
        svc.save(&def("r1", "conn_ok")).await.unwrap();
        // 在内容根目录放置包内首段同名的符号链接：副本文件写入阶段失败。
        std::os::unix::fs::symlink("/etc", _root.join("scripts")).unwrap();
        let err = svc.copy("r1").await.unwrap_err();
        assert!(matches!(err, RolesError::Validation(_)), "实际：{err:?}");
        let all = svc.list().await.unwrap();
        assert_eq!(all.len(), 1, "只应存在源角色");
        assert_eq!(all[0].base.id, "r1", "不得存在缺少文件的残缺副本");
    }

    /// SPEC「引用登记与删除约束」：无引用可删，被引用返回 Conflict 并
    /// 保留完整定义；删除后解除连接引用。
    #[tokio::test]
    async fn 删除约束与连接解除() {
        let gw = FakeGateway::with_types(&[ServiceType::OpenAiCompatible]);
        let (svc, gw, _root) = service(gw);
        svc.save(&def("r1", "conn_ok")).await.unwrap();
        svc.register_workflow_ref("r1", "wf-a").unwrap();
        let err = svc.delete("r1").await.unwrap_err();
        assert!(matches!(err, RolesError::Conflict(_)));
        assert!(svc.get("r1").await.unwrap().is_some());
        svc.unregister_workflow_ref("r1", "wf-a").unwrap();
        svc.delete("r1").await.unwrap();
        assert!(svc.get("r1").await.unwrap().is_none());
        assert_eq!(gw.unregister_calls.load(Ordering::SeqCst), 1, "删除后解除连接引用");
    }

    /// SPEC「角色创建、查询与修改」：查询未知角色返回明确的不存在结果。
    #[tokio::test]
    async fn 未知角色返回不存在() {
        let (svc, _gw, _root) = service(FakeGateway::with_types(&[ServiceType::OpenAiCompatible]));
        assert!(svc.get("ghost").await.unwrap().is_none());
        assert!(matches!(
            svc.export_freezable("ghost").await,
            Err(RolesError::NotFound(g)) if g == "ghost"
        ));
        assert!(matches!(
            svc.copy("ghost").await,
            Err(RolesError::NotFound(g)) if g == "ghost"
        ));
    }
}
