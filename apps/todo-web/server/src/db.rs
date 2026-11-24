use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, Row, ToSql};
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;
use todo_core::{Creator, Priority, Project, Status, Task, TodoError};

/// 待办库的列映射。实体字段由 `todo_core` 定义，这里只声明字段与库列的对应关系。
pub const TASK_FIELDS: [&str; 20] = [
    "id",
    "title",
    "creator",
    "created_at",
    "priority",
    "tags",
    "parent_id",
    "pre_id",
    "due",
    "status",
    "assignee",
    "blocked_reason",
    "result",
    "artifacts",
    "log",
    "started_at",
    "finished_at",
    "content",
    "project_id",
    "updated_at",
];

pub const PROJECT_FIELDS: [&str; 6] = [
    "id",
    "name",
    "description",
    "path",
    "created_at",
    "updated_at",
];

/// 数据根目录，默认 `~/.ursi`，可用 `URSI_DATA_DIR` 指向其它位置。
pub fn data_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("URSI_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".ursi")
}

/// 待办数据目录：数据根目录下的 `todo`。
pub fn default_data_dir() -> PathBuf {
    data_root().join("todo")
}

/// Reads `TODO_DB_PATH`; otherwise uses `<待办数据目录>/todo.db`.
pub fn get_db_path() -> PathBuf {
    if let Ok(path) = std::env::var("TODO_DB_PATH") {
        return PathBuf::from(path);
    }
    default_data_dir().join("todo.db")
}

pub fn connect() -> Result<Connection> {
    let path = get_db_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    Ok(conn)
}

/// 看板不建库、不迁移，只使用库里已有的列，因此先探测实际列。
#[derive(Debug)]
pub struct Columns {
    fields: Vec<&'static str>,
}

impl Columns {
    pub fn load(conn: &Connection, table: &str, wanted: &[&'static str]) -> Result<Self> {
        let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let existing = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<String>, rusqlite::Error>>()?;

        if existing.is_empty() {
            bail!("待办库里没有 {table} 表，请先用 SUMM-Todo 创建");
        }

        let fields = wanted
            .iter()
            .copied()
            .filter(|field| existing.iter().any(|column| column == field))
            .collect();
        Ok(Self { fields })
    }

    pub fn has(&self, field: &str) -> bool {
        self.fields.contains(&field)
    }

    pub fn select_list(&self) -> String {
        self.fields.join(", ")
    }
}

pub fn read_task(row: &Row<'_>, columns: &Columns) -> rusqlite::Result<Task> {
    Ok(Task {
        id: text(columns, row, "id")?.unwrap_or_default(),
        title: text(columns, row, "title")?.unwrap_or_default(),
        content: text(columns, row, "content")?,
        project_id: text(columns, row, "project_id")?,
        creator: parsed(columns, row, "creator")?.unwrap_or(Creator::Human),
        created_at: datetime(columns, row, "created_at")?.unwrap_or_else(Utc::now),
        priority: parsed(columns, row, "priority")?.unwrap_or(Priority::Medium),
        tags: json_list(text(columns, row, "tags")?),
        parent_id: text(columns, row, "parent_id")?,
        pre_id: text(columns, row, "pre_id")?,
        due: datetime(columns, row, "due")?,
        status: parsed(columns, row, "status")?.unwrap_or(Status::Pending),
        assignee: parsed(columns, row, "assignee")?,
        blocked_reason: text(columns, row, "blocked_reason")?,
        result: text(columns, row, "result")?,
        artifacts: json_list(text(columns, row, "artifacts")?),
        log: text(columns, row, "log")?,
        started_at: datetime(columns, row, "started_at")?,
        finished_at: datetime(columns, row, "finished_at")?,
        updated_at: datetime(columns, row, "updated_at")?,
    })
}

pub fn read_project(row: &Row<'_>, columns: &Columns) -> rusqlite::Result<Project> {
    Ok(Project {
        id: text(columns, row, "id")?.unwrap_or_default(),
        name: text(columns, row, "name")?.unwrap_or_default(),
        description: text(columns, row, "description")?,
        path: text(columns, row, "path")?,
        created_at: datetime(columns, row, "created_at")?.unwrap_or_else(Utc::now),
        updated_at: datetime(columns, row, "updated_at")?,
    })
}

pub fn insert_task(conn: &Connection, task: &Task, columns: &Columns) -> Result<()> {
    let mut values = present(task_values(task), columns);
    if columns.has("updated_at") {
        values.retain(|(field, _)| *field != "updated_at");
        values.push(("updated_at", Some(Utc::now().to_rfc3339())));
    }
    let fields = values
        .iter()
        .map(|(field, _)| *field)
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = placeholders(values.len());
    conn.execute(
        &format!("INSERT INTO tasks ({fields}) VALUES ({placeholders})"),
        binds(&values).as_slice(),
    )?;
    Ok(())
}

pub fn update_task_row(conn: &Connection, task: &Task, columns: &Columns) -> Result<()> {
    let values = present(task_values(task), columns)
        .into_iter()
        .filter(|(field, _)| *field != "id")
        .collect::<Vec<_>>();
    let mut assignments = values
        .iter()
        .enumerate()
        .map(|(index, (field, _))| format!("{field} = ?{}", index + 1))
        .collect::<Vec<_>>();
    if columns.has("updated_at") {
        assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')".into());
    }
    let mut params = binds(&values);
    params.push(&task.id);
    conn.execute(
        &format!(
            "UPDATE tasks SET {} WHERE id = ?{}",
            assignments.join(", "),
            values.len() + 1
        ),
        params.as_slice(),
    )?;
    Ok(())
}

pub fn insert_project(conn: &Connection, project: &Project, columns: &Columns) -> Result<()> {
    let mut values = present(project_values(project), columns);
    if columns.has("updated_at") {
        values.retain(|(field, _)| *field != "updated_at");
        values.push(("updated_at", Some(Utc::now().to_rfc3339())));
    }
    let fields = values
        .iter()
        .map(|(field, _)| *field)
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = placeholders(values.len());
    conn.execute(
        &format!("INSERT INTO projects ({fields}) VALUES ({placeholders})"),
        binds(&values).as_slice(),
    )?;
    Ok(())
}

pub fn update_project_row(conn: &Connection, project: &Project, columns: &Columns) -> Result<()> {
    let values = present(project_values(project), columns)
        .into_iter()
        .filter(|(field, _)| *field != "id")
        .collect::<Vec<_>>();
    let mut assignments = values
        .iter()
        .enumerate()
        .map(|(index, (field, _))| format!("{field} = ?{}", index + 1))
        .collect::<Vec<_>>();
    if columns.has("updated_at") {
        assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')".into());
    }
    let mut params = binds(&values);
    params.push(&project.id);
    conn.execute(
        &format!(
            "UPDATE projects SET {} WHERE id = ?{}",
            assignments.join(", "),
            values.len() + 1
        ),
        params.as_slice(),
    )?;
    Ok(())
}

pub fn parse_datetime(raw: &str) -> Option<DateTime<Utc>> {
    let formats = [
        "%Y-%m-%dT%H:%M:%S%.f%:z",
        "%Y-%m-%dT%H:%M:%S%:z",
        "%Y-%m-%d %H:%M:%S",
    ];
    for format in formats {
        if let Ok(parsed) = DateTime::parse_from_str(raw, format) {
            return Some(parsed.with_timezone(&Utc));
        }
    }

    let with_timezone = format!("{}+00:00", raw.replace(' ', "T"));
    for format in ["%Y-%m-%dT%H:%M:%S%.f%:z", "%Y-%m-%dT%H:%M:%S%:z"] {
        if let Ok(parsed) = DateTime::parse_from_str(&with_timezone, format) {
            return Some(parsed.with_timezone(&Utc));
        }
    }

    raw.parse::<DateTime<Utc>>().ok()
}

/// 已记录的完成时间：库里既有 RFC 3339，也有 SQLite `datetime()` 的本地写法。
pub fn datetime_text(value: DateTime<Utc>) -> String {
    value.to_rfc3339()
}

fn task_values(task: &Task) -> Vec<(&'static str, Option<String>)> {
    vec![
        ("id", Some(task.id.clone())),
        ("title", Some(task.title.clone())),
        ("creator", Some(task.creator.to_string())),
        ("created_at", Some(datetime_text(task.created_at))),
        ("priority", Some(task.priority.to_string())),
        ("tags", Some(json_text(&task.tags))),
        ("parent_id", task.parent_id.clone()),
        ("pre_id", task.pre_id.clone()),
        ("due", task.due.map(datetime_text)),
        ("status", Some(task.status.to_string())),
        ("assignee", task.assignee.as_ref().map(|value| value.to_string())),
        ("blocked_reason", task.blocked_reason.clone()),
        ("result", task.result.clone()),
        ("artifacts", Some(json_text(&task.artifacts))),
        ("log", task.log.clone()),
        ("started_at", task.started_at.map(datetime_text)),
        ("finished_at", task.finished_at.map(datetime_text)),
        ("content", task.content.clone()),
        ("project_id", task.project_id.clone()),
        ("updated_at", task.updated_at.map(datetime_text)),
    ]
}

fn project_values(project: &Project) -> Vec<(&'static str, Option<String>)> {
    vec![
        ("id", Some(project.id.clone())),
        ("name", Some(project.name.clone())),
        ("description", project.description.clone()),
        ("path", project.path.clone()),
        ("created_at", Some(datetime_text(project.created_at))),
        ("updated_at", project.updated_at.map(datetime_text)),
    ]
}

fn present(
    values: Vec<(&'static str, Option<String>)>,
    columns: &Columns,
) -> Vec<(&'static str, Option<String>)> {
    values
        .into_iter()
        .filter(|(field, _)| columns.has(field))
        .collect()
}

fn binds<'a>(values: &'a [(&'static str, Option<String>)]) -> Vec<&'a dyn ToSql> {
    values
        .iter()
        .map(|(_, value)| value as &dyn ToSql)
        .collect()
}

fn placeholders(count: usize) -> String {
    (1..=count)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn text(columns: &Columns, row: &Row<'_>, field: &str) -> rusqlite::Result<Option<String>> {
    if columns.has(field) {
        row.get(field)
    } else {
        Ok(None)
    }
}

fn datetime(
    columns: &Columns,
    row: &Row<'_>,
    field: &str,
) -> rusqlite::Result<Option<DateTime<Utc>>> {
    Ok(text(columns, row, field)?
        .as_deref()
        .and_then(parse_datetime))
}

fn parsed<T>(columns: &Columns, row: &Row<'_>, field: &str) -> rusqlite::Result<Option<T>>
where
    T: FromStr<Err = TodoError>,
{
    match text(columns, row, field)? {
        Some(raw) => raw
            .parse()
            .map(Some)
            .map_err(|error: TodoError| conversion_error(field, error)),
        None => Ok(None),
    }
}

fn conversion_error(field: &str, error: TodoError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        anyhow!(error).context(format!("{field} 字段取值非法")).into(),
    )
}

fn json_list(raw: Option<String>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn json_text(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".into())
}

/// 供启动检查使用：库里连 `tasks`、`projects` 表都没有时直接失败。
pub fn ensure_database(conn: &Connection) -> Result<()> {
    Columns::load(conn, "tasks", &TASK_FIELDS)?;
    Columns::load(conn, "projects", &PROJECT_FIELDS)?;
    Ok(())
}
