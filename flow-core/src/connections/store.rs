//! 连接存储：rusqlite 直连临时 SQLite，自管 schema（`user_version=1`）。
//!
//! 过渡设计说明：storage 模块正在并行开发，本模块当前不依赖
//! `crate::storage` 的事务与迁移设施，改为模块内 rusqlite 直连建表、
//! 自管迁移。后续集成时由 app 统一接线到 storage 事务设施，
//! 接线时仅需替换 `ConnectionStore::open` 的连接来源与
//! `execute` 的事务包装，公开接口保持不变。
//!
//! schema（user_version=1）：
//! - `connections`：连接完整记录（含凭据引用，不含凭据明文）；
//! - `connection_role_refs`：角色引用登记，UNIQUE(conn_id, role_id) 保证幂等。
//!
//! 并发模型：全局 `Mutex<Connection>` 串行化访问。各域写操作必须原子
//! （如 delete 的"检查登记 + 删除"必须同事务），互斥锁保证多连接句柄
//! 不会交错这两步。集成后 storage 事务设施将替代该互斥承担并发正确性。
//!
//! 敏感信息：`credential_ref` 是引用标识而非密钥，密钥从不落库。

use std::sync::Mutex;

use rusqlite::Connection;

use super::error::ConnectionError;
use super::model::{validate_connection, ModelConnection, ServiceType};

/// schema 版本。结构变更时递增并补充迁移分支。
const SCHEMA_VERSION: i32 = 1;

/// 连接存储。rusqlite 直连，模块自管 schema（见文件头过渡设计说明）。
pub struct ConnectionStore {
    conn: Mutex<Connection>,
}

impl ConnectionStore {
    /// 打开（或创建）SQLite 数据库并执行自管迁移。
    pub fn open(path: &str) -> Result<Self, ConnectionError> {
        let conn = Connection::open(path)?;
        Self::migrate(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// 自管迁移：按 `user_version` 递进建表。
    fn migrate(conn: &Connection) -> Result<(), ConnectionError> {
        let version: i32 =
            conn.query_row("SELECT user_version FROM pragma_user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(ConnectionError::Storage(format!(
                "数据库 schema 版本 {version} 高于本模块支持的 {SCHEMA_VERSION}"
            )));
        }
        if version == 0 {
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE connections (
                     id             TEXT PRIMARY KEY,
                     name           TEXT NOT NULL,
                     service_type   TEXT NOT NULL,
                     endpoint       TEXT NOT NULL,
                     credential_ref TEXT NOT NULL,
                     created_at     TEXT NOT NULL
                 );
                 CREATE TABLE connection_role_refs (
                     conn_id TEXT NOT NULL REFERENCES connections(id),
                     role_id TEXT NOT NULL,
                     UNIQUE(conn_id, role_id)
                 );
                 PRAGMA user_version = 1;
                 COMMIT;",
            )?;
        }
        Ok(())
    }

    /// 在互斥内执行（写入原子性由互斥保证，见文件头）。
    fn execute<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, ConnectionError>,
    ) -> Result<T, ConnectionError> {
        let guard = self.conn.lock().expect("连接锁中毒");
        f(&guard)
    }

    fn row_to_connection(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelConnection> {
        let service_type: String = row.get("service_type")?;
        Ok(ModelConnection {
            id: row.get("id")?,
            name: row.get("name")?,
            service_type: ServiceType::parse(&service_type),
            endpoint: row.get("endpoint")?,
            credential_ref: row.get("credential_ref")?,
            created_at: Some(row.get::<_, String>("created_at")?),
        })
    }

    /// 创建连接。校验失败时不产生任何写入。
    pub fn create(&self, input: NewConnection) -> Result<ModelConnection, ConnectionError> {
        let endpoint = validate_connection(&input.name, &input.service_type, &input.endpoint, &input.credential_ref)
            .map_err(ConnectionError::Validation)?;
        let id = format!("conn_{}", uuid::Uuid::new_v4());
        let created_at = now_rfc3339();
        self.execute(|conn| {
            conn.execute(
                "INSERT INTO connections (id, name, service_type, endpoint, credential_ref, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, input.name, input.service_type.as_str(), endpoint, input.credential_ref, created_at],
            )?;
            Ok(ModelConnection {
                id,
                name: input.name,
                service_type: input.service_type,
                endpoint,
                credential_ref: input.credential_ref,
                created_at: Some(created_at),
            })
        })
    }

    /// 列出全部连接（按创建时间排序）。
    pub fn list(&self) -> Result<Vec<ModelConnection>, ConnectionError> {
        self.execute(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, service_type, endpoint, credential_ref, created_at
                 FROM connections ORDER BY created_at ASC, id ASC",
            )?;
            let rows = stmt
                .query_map([], Self::row_to_connection)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// 读取单个连接；不存在返回 `NotFound`。
    pub fn get(&self, id: &str) -> Result<ModelConnection, ConnectionError> {
        self.execute(|conn| {
            conn.query_row(
                "SELECT id, name, service_type, endpoint, credential_ref, created_at
                 FROM connections WHERE id = ?1",
                [id],
                Self::row_to_connection,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => ConnectionError::NotFound(id.to_string()),
                other => ConnectionError::from(other),
            })
        })
    }

    /// 更新连接的可变字段。校验失败保留原配置（不做任何写入）。
    pub fn update(
        &self,
        id: &str,
        changes: ConnectionChanges,
    ) -> Result<ModelConnection, ConnectionError> {
        let endpoint = validate_connection(&changes.name, &changes.service_type, &changes.endpoint, &changes.credential_ref)
            .map_err(ConnectionError::Validation)?;
        self.execute(|conn| {
            let n = conn.execute(
                "UPDATE connections
                 SET name = ?1, service_type = ?2, endpoint = ?3, credential_ref = ?4
                 WHERE id = ?5",
                rusqlite::params![changes.name, changes.service_type.as_str(), endpoint, changes.credential_ref, id],
            )?;
            if n == 0 {
                return Err(ConnectionError::NotFound(id.to_string()));
            }
            Ok(())
        })?;
        self.get(id)
    }

    /// 删除连接。事务内检查角色引用登记，被引用返回 `Conflict` 且不删除。
    pub fn delete(&self, id: &str) -> Result<(), ConnectionError> {
        self.execute(|conn| {
            let tx = conn.unchecked_transaction()?;
            let refs: i64 = tx.query_row(
                "SELECT COUNT(*) FROM connection_role_refs WHERE conn_id = ?1",
                [id],
                |r| r.get(0),
            )?;
            if refs > 0 {
                // 显式回滚（drop 也会回滚），保证检查与删除同事务。
                tx.rollback()?;
                return Err(ConnectionError::Conflict(format!("连接 {id} 仍被 {refs} 个角色引用")));
            }
            tx.execute("DELETE FROM connections WHERE id = ?1", [id])?;
            tx.commit()?;
            Ok(())
        })
    }

    /// 登记角色引用。幂等：重复登记不产生重复行（UNIQUE 约束 + 忽略插入）。
    /// 连接必须存在，否则返回 `NotFound`。
    pub fn register_role_ref(&self, conn_id: &str, role_id: &str) -> Result<(), ConnectionError> {
        self.execute(|conn| {
            let tx = conn.unchecked_transaction()?;
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM connections WHERE id = ?1)",
                    [conn_id],
                    |r| r.get(0),
                )?;
            if !exists {
                tx.rollback()?;
                return Err(ConnectionError::NotFound(conn_id.to_string()));
            }
            tx.execute(
                "INSERT INTO connection_role_refs (conn_id, role_id) VALUES (?1, ?2)
                 ON CONFLICT(conn_id, role_id) DO NOTHING",
                [conn_id, role_id],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    /// 解除指定角色的引用登记。未登记时同样返回成功（幂等）。
    pub fn unregister_role_ref(&self, conn_id: &str, role_id: &str) -> Result<(), ConnectionError> {
        self.execute(|conn| {
            conn.execute(
                "DELETE FROM connection_role_refs WHERE conn_id = ?1 AND role_id = ?2",
                [conn_id, role_id],
            )?;
            Ok(())
        })
    }

    /// 连接是否仍被任何角色引用。
    pub fn has_refs(&self, conn_id: &str) -> Result<bool, ConnectionError> {
        self.execute(|conn| {
            let refs: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM connection_role_refs WHERE conn_id = ?1)",
                [conn_id],
                |r| r.get(0),
            )?;
            Ok(refs)
        })
    }
}

/// 新建连接输入。
#[derive(Debug, Clone)]
pub struct NewConnection {
    pub name: String,
    pub service_type: ServiceType,
    pub endpoint: String,
    pub credential_ref: String,
}

/// 连接更新输入（完整替换可变字段）。
#[derive(Debug, Clone)]
pub struct ConnectionChanges {
    pub name: String,
    pub service_type: ServiceType,
    pub endpoint: String,
    pub credential_ref: String,
}

/// 当前环境无 chrono 依赖，手工构造 RFC 3339 UTC 时间（秒级精度）。
fn now_rfc3339() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 Unix 纪元");
    let total = now.as_secs();
    let days = total / 86_400;
    let secs_of_day = total % 86_400;
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    // civ_days 算法（Howard Hinnant）：1970-01-01 起的天数转 y-m-d。
    let z = (days + 719_468) as i64;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// tempdir 故意泄漏以支撑整个测试生命周期（进程退出由系统回收）。
    fn store() -> ConnectionStore {
        leaked_store()
    }

    fn leaked_store() -> ConnectionStore {
        let dir = tempfile::tempdir().expect("创建临时目录");
        let path = dir.path().join("conn.db").to_string_lossy().to_string();
        std::mem::forget(dir);
        ConnectionStore::open(&path).expect("打开存储")
    }

    fn sample(name: &str) -> NewConnection {
        NewConnection {
            name: name.to_string(),
            service_type: ServiceType::OpenAiCompatible,
            endpoint: "https://api.example.com/v1".into(),
            credential_ref: "vault://keys/main".into(),
        }
    }

    /// SPEC「连接配置管理」：创建后能列举、读回，字段一致。
    #[test]
    fn create_后_list_get_读回一致() {
        let s = store();
        let c = s.create(sample("main")).unwrap();
        let got = s.get(&c.id).unwrap();
        assert_eq!(got, c);
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0], c);
    }

    /// SPEC「连接配置管理」：重新打开临时 SQLite 后配置与标识保持一致。
    #[test]
    fn 重开_sqlite_数据保留() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conn.db");
        let c = {
            let s = ConnectionStore::open(path.to_str().unwrap()).unwrap();
            s.create(sample("persist")).unwrap()
        };
        let s2 = ConnectionStore::open(path.to_str().unwrap()).unwrap();
        assert_eq!(s2.get(&c.id).unwrap(), c);
        assert_eq!(s2.list().unwrap().len(), 1);
    }

    /// SPEC「连接配置管理」：非法地址与缺失必需字段返回明确错误并保留原配置。
    #[test]
    fn 非法更新保留原配置() {
        let s = leaked_store();
        let c = s.create(sample("orig")).unwrap();
        let bad = ConnectionChanges {
            name: c.name.clone(),
            service_type: c.service_type.clone(),
            endpoint: "https://user:pass@api.example.com".into(),
            credential_ref: c.credential_ref.clone(),
        };
        let err = s.update(&c.id, bad).unwrap_err();
        assert!(matches!(err, ConnectionError::Validation(_)), "实际：{err:?}");
        assert_eq!(s.get(&c.id).unwrap(), c, "校验失败必须保留原配置");
        let bad2 = ConnectionChanges {
            name: String::new(),
            service_type: c.service_type.clone(),
            endpoint: "https://api.example.com".into(),
            credential_ref: "r".into(),
        };
        assert!(s.update(&c.id, bad2).is_err());
        assert_eq!(s.get(&c.id).unwrap(), c);
    }

    /// SPEC「引用登记与删除约束」：登记后删除返回 Conflict，未登记可删除。
    #[test]
    fn 被引用连接删除返回_conflict() {
        let s = leaked_store();
        let c = s.create(sample("refd")).unwrap();
        s.register_role_ref(&c.id, "role-a").unwrap();
        let err = s.delete(&c.id).unwrap_err();
        assert!(matches!(err, ConnectionError::Conflict(_)), "实际：{err:?}");
        assert!(s.get(&c.id).is_ok(), "被引用连接必须保留");

        let c2 = s.create(sample("free")).unwrap();
        s.delete(&c2.id).unwrap();
        assert!(matches!(s.get(&c2.id), Err(ConnectionError::NotFound(_))));
    }

    /// SPEC「引用登记与删除约束」：重复登记幂等；解除指定登记保留其他引用。
    #[test]
    fn 登记幂等且解除互不影响() {
        let s = leaked_store();
        let c = s.create(sample("shared")).unwrap();
        s.register_role_ref(&c.id, "role-a").unwrap();
        s.register_role_ref(&c.id, "role-a").unwrap();
        assert!(s.has_refs(&c.id).unwrap());
        s.register_role_ref(&c.id, "role-b").unwrap();

        s.unregister_role_ref(&c.id, "role-a").unwrap();
        assert!(s.has_refs(&c.id).unwrap(), "role-b 的登记必须保留");
        s.unregister_role_ref(&c.id, "role-b").unwrap();
        assert!(!s.has_refs(&c.id).unwrap());
        // 幂等：再次解除仍成功。
        s.unregister_role_ref(&c.id, "role-b").unwrap();
        // UNIQUE 约束兜底验证：表内无重复行。
        let s2 = leaked_store();
        let c2 = s2.create(sample("u")).unwrap();
        s2.register_role_ref(&c2.id, "r").unwrap();
        s2.register_role_ref(&c2.id, "r").unwrap();
        let n: i64 = {
            let guard = s2.conn.lock().unwrap();
            guard
                .query_row("SELECT COUNT(*) FROM connection_role_refs WHERE conn_id = ?1", [&c2.id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(n, 1, "重复登记不得产生重复行");
    }

    /// SPEC「引用登记与删除约束」：登记不存在连接返回 NotFound。
    #[test]
    fn 登记到不存在的连接返回_not_found() {
        let s = store();
        assert!(matches!(
            s.register_role_ref("conn_missing", "role-x"),
            Err(ConnectionError::NotFound(_))
        ));
    }

    /// SPEC「连接配置管理」：删除后查询返回不存在。
    #[test]
    fn 删除后读取返回_not_found() {
        let s = leaked_store();
        let c = s.create(sample("gone")).unwrap();
        s.delete(&c.id).unwrap();
        assert!(matches!(s.get(&c.id), Err(ConnectionError::NotFound(_))));
        assert!(s.list().unwrap().is_empty());
    }

    /// SPEC「连接配置管理」：更新后读取新配置。
    #[test]
    fn 更新后读取新配置() {
        let s = leaked_store();
        let c = s.create(sample("upd")).unwrap();
        let updated = s
            .update(
                &c.id,
                ConnectionChanges {
                    name: "upd2".into(),
                    service_type: ServiceType::Anthropic,
                    endpoint: "https://api.anthropic.com".into(),
                    credential_ref: "vault://keys/other".into(),
                },
            )
            .unwrap();
        assert_eq!(updated.service_type, ServiceType::Anthropic);
        assert_eq!(updated.endpoint, "https://api.anthropic.com");
        assert_eq!(s.get(&c.id).unwrap(), updated);
    }

    /// SPEC「存储失败与敏感信息隔离」：注入存储错误后重读仍为旧记录。
    #[test]
    fn 存储失败后旧记录保持可读() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ro.db");
        let s = ConnectionStore::open(path.to_str().unwrap()).unwrap();
        let c = s.create(sample("keep")).unwrap();
        drop(s);
        // 注入存储失败：数据库文件设为只读，UPDATE 提交必然失败。
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o444);
        std::fs::set_permissions(&path, perms).unwrap();
        let s = ConnectionStore::open(path.to_str().unwrap()).unwrap();
        let err = s
            .update(
                &c.id,
                ConnectionChanges {
                    name: "should-fail".into(),
                    service_type: ServiceType::Anthropic,
                    endpoint: "https://api.example.com".into(),
                    credential_ref: "r".into(),
                },
            )
            .unwrap_err();
        assert!(matches!(err, ConnectionError::Storage(_)), "实际：{err:?}");
        // SQLite 打开只读文件时自动降级为只读连接，旧记录仍可读。
        assert_eq!(s.get(&c.id).unwrap(), c);
        let listed = s.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], c);
        // 恢复权限，避免 tempdir 清理失败产生警告噪音。
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o644);
        std::fs::set_permissions(&path, perms).unwrap();
    }
}
