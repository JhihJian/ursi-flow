//! 角色存储：rusqlite 自管 schema，内容字节存内容寻址对象，元数据落库。
//!
//! 一致性模型（对应 DESIGN「一致性归属」）：
//! - 写入顺序「先内容后元数据」：文件字节先写入 [`ContentStore`]（内容寻址，
//!   幂等，中断不产生半份对象），元数据在同一 SQLite 事务内提交；事务失败时
//!   已写字节成为未引用内容，由 `sweep_unreferenced` 清理，不会出现半包。
//! - 删除检查同事务：`delete` 在同一事务内统计流程引用并决定删除或返回
//!   `Conflict`，并发登记与删除只有合法的串行结果。
//! - 流程引用登记提供事务内入口（`*_in_tx`），workflows 在自己的
//!   storage 事务中调用，流程定义与引用登记共同提交。
//!
//! schema（迁移随 [`migrations`] 交由 app 统一登记）：
//! - `roles`：角色完整记录（基础字段 JSON、连接选择、执行器类型、MCP JSON、
//!   包入口、时间戳），不含任何凭据明文；
//! - `role_files`：skills 文件元数据（role_id, path, content_id）；
//! - `role_refs`：流程引用登记，UNIQUE(role_id, ref_id) 保证幂等。

use rusqlite::params;
use ursi_domain::{ExecutorKind, Role};

use crate::storage::{ContentStore, Database, Migration};

use super::error::RolesError;
use super::mcp::McpServerConfig;
use super::model::RoleDefinition;
use super::skills::{SkillFile, SkillPackage};

/// 本域迁移列表：只能追加，不可改写历史条目。
pub fn migrations() -> &'static [Migration] {
    &MIGRATIONS
}

static MIGRATIONS: &[Migration] = &[Migration::new(
    "roles_v1",
    "CREATE TABLE roles (
        id             TEXT PRIMARY KEY,
        base_json      TEXT NOT NULL,
        connection_id  TEXT NOT NULL,
        executor_kind  TEXT,
        mcp_json       TEXT NOT NULL,
        entry          TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
    );
    CREATE TABLE role_files (
        role_id    TEXT NOT NULL,
        path       TEXT NOT NULL,
        content_id TEXT NOT NULL,
        PRIMARY KEY (role_id, path)
    );
    CREATE TABLE role_refs (
        role_id TEXT NOT NULL,
        ref_id  TEXT NOT NULL,
        UNIQUE(role_id, ref_id)
    );",
)];

/// 角色存储。
pub struct RoleStore {
    pub(crate) db: Database,
    pub(crate) content: ContentStore,
}

impl RoleStore {
    /// 在给定数据库与内容根目录上打开角色存储。
    /// 数据库迁移由 app 统一登记应用（独立环境测试传入 [`migrations`]）。
    pub fn new(db: Database, content: ContentStore) -> Self {
        Self { db, content }
    }

    /// 完整保存（upsert）：校验 → 先写内容 → 同事务提交元数据。
    /// 校验或内容写入失败时不产生任何数据库写入，原定义保持不变。
    pub fn save(&self, def: &RoleDefinition) -> Result<(), RolesError> {
        self.save_inner(def, SaveMode::Upsert)
    }

    /// 复制为目标标识：源不存在返回 `NotFound`；目标标识已存在返回错误
    /// （不覆盖），保证复制失败不产生残缺副本。
    pub fn copy_to(&self, src_id: &str, new_id: &str) -> Result<RoleDefinition, RolesError> {
        let mut def = self
            .get(src_id)?
            .ok_or_else(|| RolesError::NotFound(src_id.to_string()))?;
        def.base.id = new_id.to_string();
        self.save_inner(&def, SaveMode::InsertOnly)?;
        Ok(def)
    }

    /// 读取完整定义（含文件字节）。不存在返回 `Ok(None)`。
    pub fn get(&self, id: &str) -> Result<Option<RoleDefinition>, RolesError> {
        let conn = self.db.lock_conn();
        let row = conn
            .query_row(
                "SELECT base_json, connection_id, executor_kind, mcp_json, entry
                 FROM roles WHERE id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err::<_, rusqlite::Error>(other),
            })
            .map_err(RolesError::from)?;
        match row {
            None => Ok(None),
            Some((base_json, connection_id, kind, mcp_json, entry)) => {
                decode_definition(&conn, &self.content, id, &base_json, &connection_id, kind, &mcp_json, &entry)
                    .map(Some)
            }
        }
    }

    /// 列出全部完整定义（按创建时间与标识排序）。
    pub fn list(&self) -> Result<Vec<RoleDefinition>, RolesError> {
        let ids: Vec<String> = self.db.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT id FROM roles ORDER BY created_at ASC, id ASC")?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        ids.into_iter()
            .map(|id| {
                self.get(&id)?
                    .ok_or_else(|| RolesError::Storage(format!("角色 {id} 列表与详情不一致")))
            })
            .collect()
    }

    /// 删除角色：同一事务内检查流程引用，被引用返回 `Conflict` 且不删除。
    /// 成功返回被删除的完整定义（调用方用于解除连接引用等补偿）。
    pub fn delete(&self, id: &str) -> Result<RoleDefinition, RolesError> {
        let removed = self
            .get(id)?
            .ok_or_else(|| RolesError::NotFound(id.to_string()))?;
        // 「检查引用 + 删除」同连接互斥内完成，并发登记只有串行结果。
        let conn = self.db.lock_conn();
        let refs: i64 = conn.query_row(
            "SELECT COUNT(*) FROM role_refs WHERE role_id = ?1",
            [id],
            |r| r.get(0),
        )?;
        if refs > 0 {
            return Err(RolesError::Conflict(format!(
                "角色 {id} 仍被 {refs} 个流程引用"
            )));
        }
        conn.execute("DELETE FROM role_files WHERE role_id = ?1", [id])?;
        conn.execute("DELETE FROM roles WHERE id = ?1", [id])?;
        Ok(removed)
    }

    /// 流程引用登记（独立事务）：角色必须存在。幂等。
    pub fn register_workflow_ref(&self, role_id: &str, wf_id: &str) -> Result<(), RolesError> {
        let mut tx = self.db.begin().map_err(RolesError::from)?;
        self.register_workflow_ref_in_tx(tx.conn(), role_id, wf_id)?;
        tx.commit().map_err(RolesError::from)?;
        Ok(())
    }

    /// 流程引用登记（调用方事务）：workflows 在流程定义保存的同一事务内
    /// 调用。角色必须存在，重复登记幂等（UNIQUE + 忽略插入）。
    pub fn register_workflow_ref_in_tx(
        &self,
        conn: &mut rusqlite::Connection,
        role_id: &str,
        wf_id: &str,
    ) -> Result<(), RolesError> {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM roles WHERE id = ?1)",
            [role_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(RolesError::NotFound(role_id.to_string()));
        }
        conn.execute(
            "INSERT INTO role_refs (role_id, ref_id) VALUES (?1, ?2)
             ON CONFLICT(role_id, ref_id) DO NOTHING",
            params![role_id, wf_id],
        )?;
        Ok(())
    }

    /// 解除流程引用登记。未登记时同样成功（幂等），只影响指定登记。
    pub fn unregister_workflow_ref(&self, role_id: &str, wf_id: &str) -> Result<(), RolesError> {
        self.db
            .with_conn(|conn| {
                conn.execute(
                    "DELETE FROM role_refs WHERE role_id = ?1 AND ref_id = ?2",
                    params![role_id, wf_id],
                )?;
                Ok(())
            })
            .map_err(RolesError::from)
    }

    /// 角色的流程引用计数（删除约束与测试观测用）。
    pub fn workflow_ref_count(&self, role_id: &str) -> Result<i64, RolesError> {
        self.db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM role_refs WHERE role_id = ?1",
                    [role_id],
                    |r| r.get(0),
                )
            })
            .map_err(RolesError::from)
    }

    /// 保存内部实现。`InsertOnly` 用于复制：目标已存在即失败，不覆盖。
    fn save_inner(&self, def: &RoleDefinition, mode: SaveMode) -> Result<(), RolesError> {
        def.validate().map_err(RolesError::from)?;
        // 先写内容后提交元数据：全部字节成功落盘才进入数据库事务。
        let mut rows = Vec::with_capacity(def.skill_package.files.len());
        for f in &def.skill_package.files {
            let content_id = self.content.write(&f.path, &f.bytes)?;
            rows.push((f.path.clone(), content_id));
        }
        let now = now_rfc3339();
        let base_json = serde_json::to_string(&def.base)
            .map_err(|e| RolesError::Storage(e.to_string()))?;
        let mcp_json = serde_json::to_string(&def.mcp_servers_config)
            .map_err(|e| RolesError::Storage(e.to_string()))?;
        let kind = def.executor_kind.as_ref().map(|k| k.as_str().to_string());
        let role_id = def.base.id.as_str();
        self.db.with_conn(|conn| {
            let created_at = match conn.query_row(
                "SELECT created_at FROM roles WHERE id = ?1",
                [role_id],
                |r| r.get::<_, String>(0),
            ) {
                Ok(existing) => existing,
                Err(rusqlite::Error::QueryReturnedNoRows) => now.clone(),
                Err(e) => return Err(e),
            };
            match mode {
                SaveMode::Upsert => {
                    conn.execute(
                        "INSERT INTO roles (id, base_json, connection_id, executor_kind, mcp_json, entry, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                         ON CONFLICT(id) DO UPDATE SET
                            base_json = excluded.base_json,
                            connection_id = excluded.connection_id,
                            executor_kind = excluded.executor_kind,
                            mcp_json = excluded.mcp_json,
                            entry = excluded.entry,
                            updated_at = excluded.updated_at",
                        params![
                            role_id,
                            base_json,
                            def.connection_id,
                            kind,
                            mcp_json,
                            def.skill_package.entry,
                            created_at,
                            now
                        ],
                    )?;
                }
                SaveMode::InsertOnly => {
                    conn.execute(
                        "INSERT INTO roles (id, base_json, connection_id, executor_kind, mcp_json, entry, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            role_id,
                            base_json,
                            def.connection_id,
                            kind,
                            mcp_json,
                            def.skill_package.entry,
                            now,
                            now
                        ],
                    )?;
                }
            }
            conn.execute("DELETE FROM role_files WHERE role_id = ?1", [role_id])?;
            for (path, content_id) in &rows {
                conn.execute(
                    "INSERT INTO role_files (role_id, path, content_id) VALUES (?1, ?2, ?3)",
                    params![role_id, path, content_id],
                )?;
            }
            Ok(())
        })
        .map_err(RolesError::from)
    }
}

/// 保存模式：upsert（普通保存）或 insert-only（复制，目标已存在即失败）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SaveMode {
    Upsert,
    InsertOnly,
}

/// 从行数据解码完整定义：解析 JSON、执行器类型并逐文件读取内容字节。
#[allow(clippy::too_many_arguments)]
fn decode_definition(
    conn: &rusqlite::Connection,
    content: &ContentStore,
    id: &str,
    base_json: &str,
    connection_id: &str,
    kind: Option<String>,
    mcp_json: &str,
    entry: &str,
) -> Result<RoleDefinition, RolesError> {
    let base: Role = serde_json::from_str(base_json)
        .map_err(|e| RolesError::Storage(format!("角色 {id} 基础字段损坏：{e}")))?;
    let mcp: Vec<McpServerConfig> = serde_json::from_str(mcp_json)
        .map_err(|e| RolesError::Storage(format!("角色 {id} MCP 配置损坏：{e}")))?;
    let executor_kind = kind
        .map(|k| {
            ExecutorKind::parse(&k)
                .ok_or_else(|| RolesError::Storage(format!("角色 {id} 执行器类型损坏：{k}")))
        })
        .transpose()?;
    let mut stmt = conn
        .prepare("SELECT path, content_id FROM role_files WHERE role_id = ?1 ORDER BY path ASC")?;
    let rows = stmt
        .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut files = Vec::with_capacity(rows.len());
    for (path, content_id) in rows {
        let bytes = content
            .read(&content_id)
            .map_err(|e| RolesError::Storage(format!("角色 {id} 文件 {path} 内容缺失：{e}")))?;
        files.push(SkillFile::new(path, bytes));
    }
    let skill_package = SkillPackage::with_entry(entry, files)
        .map_err(|e| RolesError::Storage(format!("角色 {id} 文件包损坏：{e}")))?;
    Ok(RoleDefinition {
        base,
        skill_package,
        mcp_servers_config: mcp,
        connection_id: connection_id.to_string(),
        executor_kind,
    })
}

/// RFC 3339 UTC 时间（秒级精度）。与 connections 同款手工实现（无 chrono 依赖）。
pub(crate) fn now_rfc3339() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 Unix 纪元");
    let total = now.as_secs();
    let days = total / 86_400;
    let secs_of_day = total % 86_400;
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    let z = (days + 719_468) as i64;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    if mth <= 2 {
        y += 1;
    }
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// 兼容骨架：原 mod.rs 的 `RoleRepository`（put_role / get_role，基于
/// domain `Role`）。完整存储职责已由 [`RoleStore`] 承担，本 trait 保留为
/// 供既有调用方过渡的窄接口：只读写基础字段行，不触碰文件与引用。
pub mod legacy {
    use async_trait::async_trait;
    use ursi_domain::Role;

    use super::now_rfc3339;
    use super::RoleStore;
    use crate::storage::StoreError;

    #[async_trait]
    impl super::super::RoleRepository for RoleStore {
        async fn put_role(&self, role: &Role) -> Result<(), StoreError> {
            self.db
                .with_conn(|conn| {
                    let json = serde_json::to_string(role)
                        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
                    conn.execute(
                        "INSERT INTO roles (id, base_json, connection_id, executor_kind, mcp_json, entry, created_at, updated_at)
                         VALUES (?1, ?2, '', NULL, '[]', '', ?3, ?3)
                         ON CONFLICT(id) DO UPDATE SET base_json = excluded.base_json, updated_at = excluded.updated_at",
                        rusqlite::params![role.id, json, now_rfc3339()],
                    )?;
                    Ok(())
                })
                .map_err(|e| StoreError::Storage(e.to_string()))
        }

        async fn get_role(&self, id: &str) -> Result<Option<Role>, StoreError> {
            let json: Option<String> = self
                .db
                .with_conn(|conn| {
                    conn.query_row("SELECT base_json FROM roles WHERE id = ?1", [id], |r| {
                        r.get::<_, String>(0)
                    })
                    .map(Some)
                    .or_else(|e| match e {
                        rusqlite::Error::QueryReturnedNoRows => Ok(None),
                        other => Err(other),
                    })
                })
                .map_err(|e| StoreError::Storage(e.to_string()))?;
            json.map(|j| serde_json::from_str(&j).map_err(|e| StoreError::Storage(e.to_string())))
                .transpose()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::error::RoleValidationError;
    use crate::roles::skills::SKILL_ENTRY;

    /// tempdir 故意泄漏以支撑整个测试生命周期（进程退出由系统回收）。
    fn store() -> (Database, RoleStore) {
        let dir = tempfile::tempdir().expect("创建临时目录");
        let db_path = dir.path().join("roles.db").to_string_lossy().to_string();
        let content_root = dir.path().join("content");
        std::mem::forget(dir);
        let db = Database::open(&db_path, migrations()).expect("打开数据库");
        let content = ContentStore::open(&content_root).expect("打开内容存储");
        let store = RoleStore::new(db.clone(), content);
        (db, store)
    }

    pub(crate) fn base(id: &str) -> Role {
        crate::roles::model::test_base(id)
    }

    pub(crate) fn definition(id: &str) -> RoleDefinition {
        RoleDefinition {
            base: base(id),
            skill_package: SkillPackage::new(vec![
                SkillFile::new(SKILL_ENTRY, "# 入口说明"),
                SkillFile::new("scripts/run.sh", "#!/bin/sh\necho hi"),
                SkillFile::new("assets/模板.txt", "模板内容"),
            ])
            .unwrap(),
            mcp_servers_config: vec![McpServerConfig::Stdio {
                server: "fs".into(),
                command: "npx".into(),
                args: vec!["-y".into(), "@mcp/fs".into()],
                env: vec![("TOKEN".into(), "{{cred:mcp-token}}".into())],
            }],
            connection_id: "conn_main".into(),
            executor_kind: Some(ExecutorKind::Cli("claude-code".into())),
        }
    }

    /// SPEC「Skills 完整文件包与 MCP 配置」/「角色创建、查询与修改」：
    /// 保存含嵌套目录的完整包后逐文件读回字节一致；重新打开存储后一致。
    #[test]
    fn 保存后逐文件读回一致且重开保留() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("roles.db");
        let content_root = dir.path().join("content");
        let def = definition("r1");
        {
            let db = Database::open(&db_path, migrations()).unwrap();
            let content = ContentStore::open(&content_root).unwrap();
            let store = RoleStore::new(db, content);
            store.save(&def).unwrap();
            assert_eq!(store.get("r1").unwrap().unwrap(), def, "保存后立即读取一致");
        }
        let db = Database::open(&db_path, migrations()).unwrap();
        let content = ContentStore::open(&content_root).unwrap();
        let store = RoleStore::new(db, content);
        let got = store.get("r1").unwrap().unwrap();
        assert_eq!(got, def, "重开存储后读取一致");
        assert_eq!(
            got.skill_package.file("scripts/run.sh").unwrap().bytes,
            b"#!/bin/sh\necho hi",
            "嵌套目录文件字节一致"
        );
        assert_eq!(
            got.skill_package.file("assets/模板.txt").unwrap().bytes,
            "模板内容".as_bytes()
        );
        assert_eq!(got.mcp_servers_config, def.mcp_servers_config, "MCP 配置完整读回");
    }

    /// SPEC「角色创建、查询与修改」：列表可发现角色；修改提示词与配置后
    /// 读取新值；非法更新保留原定义；未知角色返回不存在。
    #[test]
    fn 列表修改与非法更新保留原值() {
        let (_db, store) = store();
        let mut def = definition("r1");
        store.save(&def).unwrap();
        assert_eq!(store.list().unwrap(), vec![def.clone()]);

        def.base.prompt = "更严格的评审".into();
        def.skill_package = SkillPackage::new(vec![SkillFile::new(SKILL_ENTRY, "# 新入口")]).unwrap();
        def.mcp_servers_config = vec![McpServerConfig::Http {
            server: "search".into(),
            url: "https://mcp.example.com".into(),
            headers: vec![("Authorization".into(), "vault://k".into())],
        }];
        store.save(&def).unwrap();
        let got = store.get("r1").unwrap().unwrap();
        assert_eq!(got, def, "提示词、文件包与 MCP 配置全部更新");
        // 旧文件不残留：文件行整体替换。
        assert!(got.skill_package.file("scripts/run.sh").is_none());

        // 非法更新：明文敏感 env 被拒绝，原定义保持。
        let mut bad = def.clone();
        bad.mcp_servers_config = vec![McpServerConfig::Stdio {
            server: "fs".into(),
            command: "npx".into(),
            args: vec![],
            env: vec![("TOKEN".into(), "plain-secret".into())],
        }];
        assert!(matches!(
            store.save(&bad),
            Err(RolesError::Validation(RoleValidationError::Mcp { .. }))
        ));
        assert_eq!(store.get("r1").unwrap().unwrap(), def);
        assert!(store.get("missing").unwrap().is_none());
    }

    /// SPEC「角色复制与定义交付」：深拷贝后修改副本文件与提示词不影响源；
    /// 复制目标标识冲突时失败且不产生残缺副本。
    #[test]
    fn 复制隔离与失败无残缺副本() {
        let (_db, store) = store();
        let src = definition("r1");
        store.save(&src).unwrap();
        let copy = store.copy_to("r1", "r1-copy").unwrap();
        assert_eq!(copy.base.id, "r1-copy");
        assert_eq!(copy.base.prompt, src.base.prompt, "初始配置等价");
        assert_eq!(copy.skill_package, src.skill_package);

        // 修改副本不影响源。
        let mut edited = copy.clone();
        edited.base.prompt = "副本专属提示词".into();
        edited.skill_package = SkillPackage::new(vec![
            SkillFile::new(SKILL_ENTRY, "# 副本入口"),
            SkillFile::new("scripts/run.sh", "echo copy"),
        ])
        .unwrap();
        store.save(&edited).unwrap();
        let src_after = store.get("r1").unwrap().unwrap();
        assert_eq!(src_after.base.prompt, "严格评审");
        assert_eq!(
            src_after.skill_package.file("scripts/run.sh").unwrap().bytes,
            b"#!/bin/sh\necho hi",
            "源角色文件不受副本修改影响"
        );

        // 复制目标已存在：insert-only 失败，原目标未被覆盖。
        assert!(store.copy_to("r1", "r1-copy").is_err());
        let target = store.get("r1-copy").unwrap().unwrap();
        assert_eq!(target.base.prompt, "副本专属提示词", "冲突目标不得被覆盖");
        // 源不存在 → NotFound。
        assert!(matches!(
            store.copy_to("missing", "x"),
            Err(RolesError::NotFound(m)) if m == "missing"
        ));
    }

    /// SPEC「Skills 完整文件包与 MCP 配置」：symlink 逃逸导致内容写入失败时，
    /// 保存整体失败，不留下可见的半包（原定义与文件保持完整）。
    #[test]
    fn 内容写入失败不留半包() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("roles.db"), migrations()).unwrap();
        let content = ContentStore::open(dir.path().join("content")).unwrap();
        let store = RoleStore::new(db, content);
        let def = definition("r1");
        store.save(&def).unwrap();

        // 在内容根目录放置与包内首段同名的符号链接（指向根外）。
        std::os::unix::fs::symlink("/etc", dir.path().join("content/scripts")).unwrap();
        let mut bad = def.clone();
        bad.skill_package = SkillPackage::new(vec![
            SkillFile::new(SKILL_ENTRY, "# 新入口"),
            SkillFile::new("scripts/evil.txt", "逃逸尝试"),
        ])
        .unwrap();
        assert!(matches!(
            store.save(&bad),
            Err(RolesError::Validation(RoleValidationError::SkillPath(_)))
        ));
        // 原定义完整保留，无半包。
        assert_eq!(store.get("r1").unwrap().unwrap(), def);
    }

    /// SPEC「引用登记与删除约束」：无引用可删；被引用返回 Conflict 且
    /// 定义与文件保留；解除指定引用只影响对应登记。
    #[test]
    fn 删除约束与引用隔离() {
        let (_db, store) = store();
        store.save(&definition("r1")).unwrap();
        store.register_workflow_ref("r1", "wf-a").unwrap();
        store.register_workflow_ref("r1", "wf-b").unwrap();
        let err = store.delete("r1").unwrap_err();
        assert!(matches!(err, RolesError::Conflict(_)));
        assert_eq!(store.get("r1").unwrap().unwrap(), definition("r1"), "冲突后完整定义与文件保留");

        store.unregister_workflow_ref("r1", "wf-a").unwrap();
        assert_eq!(store.workflow_ref_count("r1").unwrap(), 1, "只解除指定登记");
        assert!(store.delete("r1").is_err());
        store.unregister_workflow_ref("r1", "wf-b").unwrap();
        store.delete("r1").unwrap();
        assert!(store.get("r1").unwrap().is_none());
        // 删除后登记入口返回角色不存在。
        assert!(matches!(
            store.register_workflow_ref("r1", "wf-x"),
            Err(RolesError::NotFound(m)) if m == "r1"
        ));
    }

    /// SPEC「引用登记与删除约束」：同事务登记后回滚引用状态恢复原值；
    /// 重复登记幂等不产生重复引用。
    #[test]
    fn 事务回滚恢复引用且登记幂等() {
        let (db, store) = store();
        store.save(&definition("r1")).unwrap();
        {
            let mut tx = db.begin().unwrap();
            store
                .register_workflow_ref_in_tx(tx.conn(), "r1", "wf-rollback")
                .unwrap();
            // 不提交，作用域退出自动回滚。
        }
        assert_eq!(store.workflow_ref_count("r1").unwrap(), 0, "回滚后引用恢复原值");
        store.delete("r1").unwrap();

        store.save(&definition("r2")).unwrap();
        store.register_workflow_ref("r2", "wf-1").unwrap();
        store.register_workflow_ref("r2", "wf-1").unwrap();
        assert_eq!(store.workflow_ref_count("r2").unwrap(), 1, "重复登记幂等");
    }
}
