//! 产物存储：元数据 SQLite 表 + 内容寻址存储的两段式写入边界。
//!
//! 本域拥有 `artifacts` 表（业务表归业务域，见 storage SPEC），迁移列表
//! [`ARTIFACT_MIGRATIONS`] 供 app 登记；独立测试直接把
//! `Database::open(path, ARTIFACT_MIGRATIONS)` 与 `ContentStore::open(root)`
//! 传给 [`ArtifactStore::new`]。
//!
//! 写入顺序（文档化契约，DESIGN「状态、事件与产物」：先稳定保存内容，再发布
//! 元数据引用）：
//! 1. 逻辑路径元数据层校验（相对路径、拒绝 `..` 与绝对路径）；
//! 2. 内容经 `ContentStore.write` 稳定落盘（内容寻址，同内容幂等；符号链接
//!    逃逸在文件系统层拒绝）；
//! 3. 元数据单语句提交（SQLite 原子）。任一步失败不产生可见记录，第 2 步
//!    遗留的未引用内容由 [`ArtifactStore::sweep_orphans`] 按时间清理。
//! 故障注入入口 [`ArtifactStore::put_with_failpoint`] 在第 2/3 步边界返回
//! 错误，用于验收「重开后可见记录均完整可读、无半成品」。
//!
//! 幂等语义：`idempotency_key` 全域唯一（表级 UNIQUE）。同键重试先查既有
//! 记录：关键字段（run/node/generation/attempt/name/path/media_type/required/
//! 内容 sha256）全部一致则复用原 artifact_id（插入撞唯一键后同样走查询
//! 复用，并发重试收敛为一条记录）；任一不同返回 [`ArtifactError::Conflict`]。
//!
//! rusqlite 为同步接口：本域方法均为同步方法，异步调用方按 storage 约定
//! 以 `tokio::task::block_in_place` 包裹。

use std::path::{Component, Path};
use std::time::Duration;

use async_trait::async_trait;
use rusqlite::OptionalExtension;

use sha2::{Digest, Sha256};
use crate::domain::Artifact;

use crate::storage::{ContentError, ContentStore, Database, Migration, StoreError};

use super::{ArtifactError, ArtifactRepository};

/// artifacts 域迁移（登记到 app 的统一迁移列表，顺序只可追加）。
pub const ARTIFACT_MIGRATIONS: &[Migration] = &[Migration::new(
    "artifacts_domain_create",
    "CREATE TABLE artifacts (
        artifact_id     TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL,
        node_id         TEXT NOT NULL,
        generation      INTEGER NOT NULL,
        attempt         INTEGER NOT NULL,
        name            TEXT NOT NULL,
        path            TEXT NOT NULL,
        content_id      TEXT NOT NULL,
        media_type      TEXT,
        size            INTEGER NOT NULL,
        sha256          TEXT NOT NULL,
        required        INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        UNIQUE(idempotency_key)
    );
    CREATE INDEX artifacts_scope_idx
        ON artifacts(run_id, node_id, generation, attempt);",
)];

/// 产物元数据记录：内容与归属的唯一事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactRecord {
    pub artifact_id: String,
    pub run_id: String,
    pub node_id: String,
    /// 运行持有代数。
    pub generation: u64,
    /// runs 分配的节点累计执行编号，重试与返工均递增、不复用。
    pub attempt: u64,
    pub name: String,
    /// 逻辑路径（相对受控根，供契约匹配与调用方交付）。
    pub path: String,
    /// 稳定内容标识（sha256 hex），物理位置由 ContentStore 管理。
    pub content_id: String,
    pub media_type: Option<String>,
    pub size: u64,
    pub sha256: String,
    pub required: bool,
    pub idempotency_key: String,
    pub created_at: String,
}

impl ArtifactRecord {
    /// 映射为 domain 产物视图（契约检查等只读用途）。
    pub(crate) fn to_domain(&self) -> Artifact {
        Artifact {
            id: self.artifact_id.clone(),
            name: self.name.clone(),
            path: self.path.clone(),
            required: self.required,
            media_type: self.media_type.clone(),
        }
    }
}

/// 产物写入请求。`bytes` 完整内容随请求提交，media_type 空串视为未声明。
#[derive(Debug, Clone)]
pub struct PutArtifactRequest {
    pub run_id: String,
    pub node_id: String,
    pub generation: u64,
    pub attempt: u64,
    pub name: String,
    pub path: String,
    pub bytes: Vec<u8>,
    pub media_type: Option<String>,
    pub required: bool,
    pub idempotency_key: String,
}

/// 产物元数据 + 完整内容（`get` 返回）。
#[derive(Debug, Clone)]
pub struct ArtifactObject {
    pub record: ArtifactRecord,
    pub bytes: Vec<u8>,
}

/// 元数据行查询列清单（读写共用，顺序与 `row_to_record` 对应）。
const RECORD_COLUMNS: &str = "artifact_id, run_id, node_id, generation, attempt, name, path, \
     content_id, media_type, size, sha256, required, idempotency_key, created_at";

/// 产物存储：组合本域元数据库与内容存储。
pub struct ArtifactStore {
    db: Database,
    content: ContentStore,
}

impl ArtifactStore {
    /// 由调用方传入 `Database` 与 `ContentStore` 构造。数据库需已应用
    /// [`ARTIFACT_MIGRATIONS`]（`Database::open` 时传入）。
    pub fn new(db: Database, content: ContentStore) -> Self {
        Self { db, content }
    }

    /// 写入产物：路径校验 → 内容落盘 → 元数据提交。
    /// 同幂等键的合法重试复用原记录，返回同一 artifact_id。
    pub fn put(&self, req: PutArtifactRequest) -> Result<ArtifactRecord, ArtifactError> {
        self.put_with_failpoint(req, false)
    }

    /// 带 故障注入 的写入：`fail_after_content = true` 时在「内容已落盘、
    /// 元数据未提交」边界返回 [`ArtifactError::Failpoint`]，用于验收半成品
    /// 不可见与孤儿内容清理。生产调用走 [`ArtifactStore::put`]。
    pub fn put_with_failpoint(
        &self,
        req: PutArtifactRequest,
        fail_after_content: bool,
    ) -> Result<ArtifactRecord, ArtifactError> {
        validate_request(&req)?;
        let media_type = normalize_media_type(req.media_type.clone());
        let size = req.bytes.len() as u64;

        // 1. 内容先稳定落盘：内容寻址，同内容幂等；符号链接逃逸在此拒绝。
        let content_id = self
            .content
            .write(&req.path, &req.bytes)
            .map_err(map_content_write_err)?;

        // 2. 故障注入边界：内容已落盘，元数据未提交（无可见记录，内容可 sweep）。
        if fail_after_content {
            return Err(ArtifactError::Failpoint(format!(
                "内容已落盘（content_id={content_id}），元数据未提交"
            )));
        }

        // 3. 元数据提交（单语句原子）；唯一键冲突时复用既有记录或报冲突。
        match self.insert_metadata(&req, &media_type, &content_id, size)? {
            InsertOutcome::Inserted(record) => Ok(record),
            InsertOutcome::KeyConflict => {
                self.resolve_idempotent_retry(&req, &media_type, &content_id)
            }
        }
    }

    /// 读取元数据 + 完整内容。内容缺失或与元数据校验信息不符返回
    /// [`ArtifactError::Content`]，错误不携带根目录外路径。
    pub fn get(&self, artifact_id: &str) -> Result<ArtifactObject, ArtifactError> {
        let record = self.get_meta(artifact_id)?;
        let bytes = self
            .content
            .read(&record.content_id)
            .map_err(|e| ArtifactError::Content(format!("产物 {artifact_id} 内容不可读：{e}")))?;
        verify_integrity(&record, &bytes)?;
        Ok(ArtifactObject { record, bytes })
    }

    /// 仅读取元数据；未知标识返回 [`ArtifactError::NotFound`]。
    pub fn get_meta(&self, artifact_id: &str) -> Result<ArtifactRecord, ArtifactError> {
        let sql = format!("SELECT {RECORD_COLUMNS} FROM artifacts WHERE artifact_id = ?1");
        let row = self
            .db
            .with_conn(|conn| {
                let row = conn.query_row(&sql, [artifact_id], row_to_record).optional()?;
                Ok(row)
            })
            .map_err(ArtifactError::from)?;
        row.ok_or_else(|| ArtifactError::NotFound(artifact_id.to_string()))
    }

    /// 跨 run 列举已提交的归档记录，不读取内容对象。
    pub fn list_all(&self) -> Result<Vec<ArtifactRecord>, ArtifactError> {
        let sql = format!("SELECT {RECORD_COLUMNS} FROM artifacts ORDER BY created_at ASC, artifact_id ASC");
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([], row_to_record)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        }).map_err(ArtifactError::from)
    }

    /// 按 run 范围列举，可再按 node / generation / attempt 过滤。
    pub fn list(
        &self,
        run_id: &str,
        node_id: Option<&str>,
        generation: Option<u64>,
        attempt: Option<u64>,
    ) -> Result<Vec<ArtifactRecord>, ArtifactError> {
        let mut sql = format!("SELECT {RECORD_COLUMNS} FROM artifacts WHERE run_id = ?1");
        if node_id.is_some() {
            sql.push_str(" AND node_id = ?2");
        }
        if generation.is_some() {
            sql.push_str(&format!(" AND generation = ?{}", 2 + node_id.is_some() as usize));
        }
        if attempt.is_some() {
            sql.push_str(&format!(
                " AND attempt = ?{}",
                2 + node_id.is_some() as usize + generation.is_some() as usize
            ));
        }
        sql.push_str(" ORDER BY created_at ASC, artifact_id ASC");

        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(run_id.to_string())];
            if let Some(node) = node_id {
                params.push(Box::new(node.to_string()));
            }
            if let Some(value) = generation {
                params.push(Box::new(value as i64));
            }
            if let Some(value) = attempt {
                params.push(Box::new(value as i64));
            }
            let rows = stmt.query_map(
                rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
                row_to_record,
            )?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .map_err(ArtifactError::from)
    }

    /// 清理孤儿内容：以元数据 `content_id` 引用为准，被引用的保留（保持
    /// 可读），写入时间早于 `older_than` 的未引用内容由 ContentStore 删除。
    /// 返回被清理的内容标识列表。
    pub fn sweep_orphans(&self, older_than: Duration) -> Result<Vec<String>, ArtifactError> {
        let referenced = self.db.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT content_id FROM artifacts")?;
            let ids = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })?;
        self.content
            .sweep_unreferenced(&referenced, older_than)
            .map_err(|e| ArtifactError::Content(format!("孤儿内容清理失败：{e}")))
    }

    /// 插入元数据行。撞 `UNIQUE(idempotency_key)` 时返回 `KeyConflict`
    /// （由调用方查询复用或判定冲突），其余错误映射为存储错误。
    fn insert_metadata(
        &self,
        req: &PutArtifactRequest,
        media_type: &Option<String>,
        content_id: &str,
        size: u64,
    ) -> Result<InsertOutcome, ArtifactError> {
        let artifact_id = uuid::Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        let conn = self.db.conn();
        let conn = conn.lock().expect("数据库连接互斥锁中毒");
        let result = conn.execute(
            "INSERT INTO artifacts (artifact_id, run_id, node_id, generation, attempt, name, path,
                 content_id, media_type, size, sha256, required, idempotency_key, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![
                artifact_id,
                req.run_id,
                req.node_id,
                req.generation as i64,
                req.attempt as i64,
                req.name,
                req.path,
                content_id,
                media_type,
                size as i64,
                content_id, // sha256 即内容标识（内容寻址）
                req.required,
                req.idempotency_key,
                created_at,
            ],
        );
        drop(conn);
        match result {
            Ok(_) => Ok(InsertOutcome::Inserted(ArtifactRecord {
                artifact_id,
                run_id: req.run_id.clone(),
                node_id: req.node_id.clone(),
                generation: req.generation,
                attempt: req.attempt,
                name: req.name.clone(),
                path: req.path.clone(),
                content_id: content_id.to_string(),
                media_type: media_type.clone(),
                size,
                sha256: content_id.to_string(),
                required: req.required,
                idempotency_key: req.idempotency_key.clone(),
                created_at,
            })),
            Err(err) if is_unique_violation(&err) => Ok(InsertOutcome::KeyConflict),
            Err(err) => Err(ArtifactError::Storage(err.to_string())),
        }
    }

    /// 同幂等键重试的收敛：既有记录与本次请求的关键字段全部一致则复用
    /// 原记录（并发重试由此收敛为同一 artifact_id）；任一不同即冲突。
    fn resolve_idempotent_retry(
        &self,
        req: &PutArtifactRequest,
        media_type: &Option<String>,
        content_id: &str,
    ) -> Result<ArtifactRecord, ArtifactError> {
        let existing = self.find_by_key(&req.idempotency_key)?;
        match existing {
            Some(record) if record_matches(&record, req, media_type, content_id) => Ok(record),
            Some(record) => Err(ArtifactError::Conflict(describe_conflict(
                &record, req, media_type, content_id,
            ))),
            // 唯一键约束已确认存在冲突行，查询不到属于存储不一致，防御性报错。
            None => Err(ArtifactError::Storage(format!(
                "幂等键 {} 触发唯一约束但查不到既有记录",
                req.idempotency_key
            ))),
        }
    }

    /// 按幂等键查询既有记录。
    fn find_by_key(&self, key: &str) -> Result<Option<ArtifactRecord>, ArtifactError> {
        let sql = format!("SELECT {RECORD_COLUMNS} FROM artifacts WHERE idempotency_key = ?1");
        self.db
            .with_conn(|conn| {
                let row = conn.query_row(&sql, [key], row_to_record).optional()?;
                Ok(row)
            })
            .map_err(ArtifactError::from)
    }
}

/// 插入结果：成功或撞幂等键唯一约束。
enum InsertOutcome {
    Inserted(ArtifactRecord),
    KeyConflict,
}

/// 既有端口实现：按 run 列举 domain 产物视图，供 app 适配器装配。
#[async_trait]
impl ArtifactRepository for ArtifactStore {
    async fn list_artifacts(&self, run_id: &str) -> Result<Vec<Artifact>, StoreError> {
        let records = self.list(run_id, None, None, None).map_err(|err| match err {
            ArtifactError::NotFound(id) => StoreError::NotFound(id),
            other => StoreError::Storage(other.to_string()),
        })?;
        Ok(records.iter().map(ArtifactRecord::to_domain).collect())
    }
}

/// 元数据写入前的请求校验与归一：归属字段非空、逻辑路径合法。
/// 失败请求不触碰内容存储与元数据表。
fn validate_request(req: &PutArtifactRequest) -> Result<(), ArtifactError> {
    for (field, value) in [
        ("run_id", &req.run_id),
        ("node_id", &req.node_id),
        ("name", &req.name),
        ("idempotency_key", &req.idempotency_key),
    ] {
        if value.is_empty() {
            return Err(ArtifactError::Invalid(format!("归属字段 {field} 不能为空")));
        }
    }
    validate_path(&req.path)
}

/// 逻辑路径校验（元数据层）：非空相对路径，组件只允许普通名称。
/// 绝对路径、`..` 穿越与 `.` 分段一律拒绝；符号链接逃逸由 ContentStore
/// 在文件系统层拒绝（两层校验互补）。
fn validate_path(path: &str) -> Result<(), ArtifactError> {
    if path.is_empty() {
        return Err(ArtifactError::Invalid("产物路径不能为空".to_string()));
    }
    let logical = Path::new(path);
    if logical.is_absolute() {
        return Err(ArtifactError::Invalid(format!(
            "产物路径必须为相对路径：{path}"
        )));
    }
    for component in logical.components() {
        match component {
            Component::Normal(_) => {}
            Component::ParentDir => {
                return Err(ArtifactError::Invalid(format!(
                    "产物路径不允许 .. 穿越：{path}"
                )));
            }
            Component::CurDir => {
                return Err(ArtifactError::Invalid(format!(
                    "产物路径分段必须为普通名称：{path}"
                )));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(ArtifactError::Invalid(format!(
                    "产物路径必须为相对路径：{path}"
                )));
            }
        }
    }
    Ok(())
}

/// 元数据层 media_type 归一：空串视为未声明。
fn normalize_media_type(media_type: Option<String>) -> Option<String> {
    media_type.filter(|s| !s.is_empty())
}

/// 关键字段一致判定：同键重试收敛复用的条件。
fn record_matches(
    record: &ArtifactRecord,
    req: &PutArtifactRequest,
    media_type: &Option<String>,
    content_id: &str,
) -> bool {
    record.run_id == req.run_id
        && record.node_id == req.node_id
        && record.generation == req.generation
        && record.attempt == req.attempt
        && record.name == req.name
        && record.path == req.path
        && record.media_type == *media_type
        && record.required == req.required
        && record.sha256 == content_id
}

/// 冲突原因描述：逐项列出与既有记录不一致的字段，可定位既有 artifact_id。
fn describe_conflict(
    record: &ArtifactRecord,
    req: &PutArtifactRequest,
    media_type: &Option<String>,
    content_id: &str,
) -> String {
    let mut diffs: Vec<&str> = Vec::new();
    if record.run_id != req.run_id {
        diffs.push("run_id");
    }
    if record.node_id != req.node_id {
        diffs.push("node_id");
    }
    if record.generation != req.generation {
        diffs.push("generation");
    }
    if record.attempt != req.attempt {
        diffs.push("attempt");
    }
    if record.name != req.name {
        diffs.push("name");
    }
    if record.path != req.path {
        diffs.push("path");
    }
    if record.media_type != *media_type {
        diffs.push("media_type");
    }
    if record.required != req.required {
        diffs.push("required");
    }
    if record.sha256 != content_id {
        diffs.push("内容(sha256)");
    }
    format!(
        "幂等键 {} 已绑定产物 {}，本次请求与原记录不一致的字段：{}",
        req.idempotency_key,
        record.artifact_id,
        diffs.join("、")
    )
}

/// 内容读取后的完整性校验：sha256 与 size 必须与元数据一致。
fn verify_integrity(record: &ArtifactRecord, bytes: &[u8]) -> Result<(), ArtifactError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let actual = hex::encode(hasher.finalize());
    if actual != record.sha256 {
        return Err(ArtifactError::Content(format!(
            "产物 {} 内容校验不符：元数据 sha256={}，实际 sha256={}",
            record.artifact_id, record.sha256, actual
        )));
    }
    if bytes.len() as u64 != record.size {
        return Err(ArtifactError::Content(format!(
            "产物 {} 内容大小不符：元数据 size={}，实际 size={}",
            record.artifact_id,
            record.size,
            bytes.len()
        )));
    }
    Ok(())
}

/// 内容写入错误映射：路径越界为请求错误，其余为存储错误。
fn map_content_write_err(err: ContentError) -> ArtifactError {
    match err {
        ContentError::InvalidPath(path) => {
            ArtifactError::Invalid(format!("产物路径被内容存储拒绝：{path}"))
        }
        other => ArtifactError::Storage(format!("内容写入失败：{other}")),
    }
}

/// UNIQUE 约束冲突识别（幂等键重复）。
fn is_unique_violation(err: &rusqlite::Error) -> bool {
    matches!(err, rusqlite::Error::SqliteFailure(ffi, _)
        if ffi.code == rusqlite::ErrorCode::ConstraintViolation
            && (ffi.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                || ffi.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT))
}

/// 行到记录映射（列顺序与 `RECORD_COLUMNS` 一致，按列名取值）。
fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtifactRecord> {
    Ok(ArtifactRecord {
        artifact_id: row.get("artifact_id")?,
        run_id: row.get("run_id")?,
        node_id: row.get("node_id")?,
        generation: row.get::<_, i64>("generation")? as u64,
        attempt: row.get::<_, i64>("attempt")? as u64,
        name: row.get("name")?,
        path: row.get("path")?,
        content_id: row.get("content_id")?,
        media_type: row.get("media_type")?,
        size: row.get::<_, i64>("size")? as u64,
        sha256: row.get("sha256")?,
        required: row.get::<_, i64>("required")? != 0,
        idempotency_key: row.get("idempotency_key")?,
        created_at: row.get("created_at")?,
    })
}

/// 当前 RFC 3339 UTC 时间（秒级精度），与 workflows / connections 域实现一致。
fn now_rfc3339() -> String {
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
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let raw_year = yoe + era * 400;
    let year = if month <= 2 { raw_year + 1 } else { raw_year };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

impl From<StoreError> for ArtifactError {
    fn from(err: StoreError) -> Self {
        match err {
            StoreError::NotFound(id) => ArtifactError::NotFound(id),
            other => ArtifactError::Storage(other.to_string()),
        }
    }
}

