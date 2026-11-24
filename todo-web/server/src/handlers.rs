use crate::db;
use crate::models::{
    CreateProjectRequest, CreateResponse, CreateTaskRequest, ProjectStats, ProjectsResponse, Stats,
    StatsResponse, SuccessResponse, Task, TaskCount, TasksResponse, UpdateProjectRequest,
    UpdateTaskRequest,
};
use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Json},
};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use rusqlite::{Connection, ToSql};
use serde::Deserialize;

const PRIORITIES: [&str; 3] = ["high", "medium", "low"];
const STATUSES: [&str; 5] = ["pending", "in_progress", "blocked", "done", "cancelled"];

pub type ApiResult<T> = Result<T, AppError>;

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    NotFound(String),
    Internal(anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            AppError::NotFound(message) => (StatusCode::NOT_FOUND, message),
            AppError::Internal(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(error)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Internal(error.into())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::Internal(error.into())
    }
}

#[derive(Debug, Deserialize)]
pub struct ProjectsQuery {
    pub active_only: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct TasksQuery {
    pub project: Option<String>,
    pub status: Option<String>,
    pub period: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StatsQuery {
    pub period: Option<String>,
}

pub async fn get_projects(Query(query): Query<ProjectsQuery>) -> ApiResult<Json<ProjectsResponse>> {
    let conn = db::connect()?;
    let projects = fetch_projects(&conn, query.active_only.unwrap_or(true))?;
    Ok(Json(ProjectsResponse { projects }))
}

pub async fn get_tasks(Query(query): Query<TasksQuery>) -> ApiResult<Json<TasksResponse>> {
    let conn = db::connect()?;
    let tasks = fetch_tasks(
        &conn,
        query.project.as_deref(),
        query.status.as_deref(),
        query.period.as_deref(),
    )?;
    Ok(Json(TasksResponse { tasks }))
}

pub async fn get_stats(Query(query): Query<StatsQuery>) -> ApiResult<Json<StatsResponse>> {
    let conn = db::connect()?;
    let period = query.period.unwrap_or_else(|| "daily".to_string());
    let stats = calculate_stats(&conn, &period)?;
    Ok(Json(StatsResponse { stats }))
}

pub async fn post_project(
    Json(request): Json<CreateProjectRequest>,
) -> ApiResult<(StatusCode, Json<CreateResponse>)> {
    let conn = db::connect()?;
    let id = create_project(&conn, &request)?;
    Ok((StatusCode::CREATED, Json(CreateResponse { id })))
}

pub async fn put_project(
    Path(id): Path<String>,
    Json(request): Json<UpdateProjectRequest>,
) -> ApiResult<Json<SuccessResponse>> {
    let conn = db::connect()?;
    update_project(&conn, &id, &request)?;
    Ok(Json(SuccessResponse { success: true }))
}

pub async fn remove_project(Path(id): Path<String>) -> ApiResult<Json<SuccessResponse>> {
    let conn = db::connect()?;
    delete_project(&conn, &id)?;
    Ok(Json(SuccessResponse { success: true }))
}

pub async fn post_task(
    Json(request): Json<CreateTaskRequest>,
) -> ApiResult<(StatusCode, Json<CreateResponse>)> {
    let conn = db::connect()?;
    let id = create_task(&conn, &request)?;
    Ok((StatusCode::CREATED, Json(CreateResponse { id })))
}

pub async fn put_task(
    Path(id): Path<String>,
    Json(request): Json<UpdateTaskRequest>,
) -> ApiResult<Json<SuccessResponse>> {
    let conn = db::connect()?;
    update_task(&conn, &id, &request)?;
    Ok(Json(SuccessResponse { success: true }))
}

pub async fn remove_task(Path(id): Path<String>) -> ApiResult<Json<SuccessResponse>> {
    let conn = db::connect()?;
    delete_task(&conn, &id)?;
    Ok(Json(SuccessResponse { success: true }))
}

pub fn fetch_projects(conn: &Connection, active_only: bool) -> ApiResult<Vec<ProjectStats>> {
    let mut statement = conn.prepare(
        "SELECT p.id, p.name, p.description, p.path,
                COALESCE(SUM(CASE WHEN t.status = 'pending' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE
                    WHEN t.status = 'done' AND t.started_at IS NOT NULL AND t.finished_at IS NOT NULL
                    THEN CAST((julianday(replace(t.finished_at, 'T', ' '))
                             - julianday(replace(t.started_at, 'T', ' '))) * 24 * 60 AS INTEGER)
                    ELSE 0 END), 0)
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id
         GROUP BY p.id, p.name, p.description, p.path
         ORDER BY p.created_at DESC",
    )?;

    let mut projects = statement
        .query_map([], |row| {
            Ok(ProjectStats {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                path: row.get(3)?,
                task_count: TaskCount {
                    pending: row.get(4)?,
                    in_progress: row.get(5)?,
                    blocked: row.get(6)?,
                    done: row.get(7)?,
                },
                total_time_minutes: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if active_only {
        projects.retain(|project| {
            project.task_count.pending > 0
                || project.task_count.in_progress > 0
                || project.task_count.blocked > 0
        });
    }

    projects.sort_by(|a, b| {
        let active = |project: &ProjectStats| {
            project.task_count.pending + project.task_count.in_progress + project.task_count.blocked
        };
        active(b).cmp(&active(a))
    });

    Ok(projects)
}

pub fn fetch_tasks(
    conn: &Connection,
    project: Option<&str>,
    status: Option<&str>,
    period: Option<&str>,
) -> ApiResult<Vec<Task>> {
    let mut sql = String::from(
        "SELECT id, title, priority, status, tags, project_id, created_at,
                started_at, finished_at, blocked_reason, result
         FROM tasks WHERE 1 = 1",
    );
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(project) = project {
        sql.push_str(" AND project_id = ?");
        params.push(Box::new(project.to_string()));
    }

    if let Some(status) = status {
        sql.push_str(" AND status = ?");
        params.push(Box::new(status.to_string()));
    }

    if let Some(range) = period.and_then(period_range) {
        // 只按完成时间过滤已完成任务，未完成任务始终可见。
        sql.push_str(
            " AND (status != 'done' OR (
                  finished_at IS NOT NULL
                  AND datetime(replace(finished_at, 'T', ' ')) BETWEEN datetime(?) AND datetime(?)))",
        );
        params.push(Box::new(range.start));
        params.push(Box::new(range.end));
    }

    sql.push_str(
        " ORDER BY
            CASE WHEN status = 'done' THEN 1 ELSE 0 END,
            CASE WHEN status != 'done' THEN
                CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
            END,
            CASE WHEN status != 'done' THEN created_at END ASC,
            finished_at DESC",
    );

    let params: Vec<&dyn ToSql> = params.iter().map(|param| param.as_ref()).collect();
    let mut statement = conn.prepare(&sql)?;
    let tasks = statement
        .query_map(params.as_slice(), |row| {
            let tags_json: String = row.get(4)?;
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                priority: row.get(2)?,
                status: row.get(3)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                project_id: row.get(5)?,
                created_at: parse_datetime(&row.get::<_, String>(6)?),
                started_at: row
                    .get::<_, Option<String>>(7)?
                    .as_deref()
                    .and_then(parse_datetime_opt),
                finished_at: row
                    .get::<_, Option<String>>(8)?
                    .as_deref()
                    .and_then(parse_datetime_opt),
                blocked_reason: row.get(9)?,
                result: row.get(10)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(tasks)
}

pub fn calculate_stats(conn: &Connection, period: &str) -> ApiResult<Stats> {
    let range = period_range(period)
        .unwrap_or_else(|| period_range("daily").expect("daily range always exists"));

    let total_tasks: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tasks
         WHERE status = 'done' AND finished_at IS NOT NULL
           AND datetime(replace(finished_at, 'T', ' ')) BETWEEN datetime(?1) AND datetime(?2)",
        [&range.start, &range.end],
        |row| row.get(0),
    )?;

    let total_time_minutes: i64 = conn.query_row(
        "SELECT COALESCE(SUM(
             CAST((julianday(replace(finished_at, 'T', ' '))
                  - julianday(replace(started_at, 'T', ' '))) * 24 * 60 AS INTEGER)
         ), 0)
         FROM tasks
         WHERE status = 'done'
           AND started_at IS NOT NULL AND finished_at IS NOT NULL
           AND datetime(replace(finished_at, 'T', ' ')) BETWEEN datetime(?1) AND datetime(?2)",
        [&range.start, &range.end],
        |row| row.get(0),
    )?;

    let count_created = |status: &str| -> ApiResult<i64> {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM tasks
             WHERE status = ?1
               AND datetime(replace(created_at, 'T', ' ')) BETWEEN datetime(?2) AND datetime(?3)",
            rusqlite::params![status, range.start, range.end],
            |row| row.get(0),
        )?)
    };

    let by_status = TaskCount {
        pending: count_created("pending")?,
        in_progress: count_created("in_progress")?,
        blocked: count_created("blocked")?,
        done: total_tasks,
    };

    Ok(Stats {
        period: period.to_string(),
        start: range.start[..10].to_string(),
        end: range.end[..10].to_string(),
        total_tasks,
        total_time_minutes,
        by_status,
    })
}

pub fn create_project(conn: &Connection, request: &CreateProjectRequest) -> ApiResult<String> {
    let name = required_text(&request.name, "Project name")?;
    let id = uuid::Uuid::new_v4().to_string();
    let description = optional_text(request.description.as_deref());
    let path = optional_text(request.path.as_deref());
    conn.execute(
        "INSERT INTO projects (id, name, description, path, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![&id, name, description, path, Utc::now().to_rfc3339()],
    )?;
    Ok(id)
}

pub fn update_project(
    conn: &Connection,
    id: &str,
    request: &UpdateProjectRequest,
) -> ApiResult<()> {
    ensure_project_exists(conn, id)?;

    let mut updates: Vec<&str> = Vec::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(name) = &request.name {
        let name = required_text(name, "Project name")?;
        updates.push("name = ?");
        params.push(Box::new(name.to_string()));
    }
    if let Some(description) = &request.description {
        updates.push("description = ?");
        params.push(Box::new(
            optional_text(description.as_deref()).map(str::to_string),
        ));
    }
    if let Some(path) = &request.path {
        updates.push("path = ?");
        params.push(Box::new(optional_text(path.as_deref()).map(str::to_string)));
    }

    if updates.is_empty() {
        return Ok(());
    }

    updates.push("updated_at = ?");
    params.push(Box::new(Utc::now().to_rfc3339()));
    params.push(Box::new(id.to_string()));

    let sql = format!("UPDATE projects SET {} WHERE id = ?", updates.join(", "));
    let params: Vec<&dyn ToSql> = params.iter().map(|param| param.as_ref()).collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

pub fn delete_project(conn: &Connection, id: &str) -> ApiResult<()> {
    ensure_project_exists(conn, id)?;
    conn.execute(
        "UPDATE tasks SET project_id = NULL WHERE project_id = ?",
        [id],
    )?;
    conn.execute("DELETE FROM projects WHERE id = ?", [id])?;
    Ok(())
}

pub fn create_task(conn: &Connection, request: &CreateTaskRequest) -> ApiResult<String> {
    let title = required_text(&request.title, "Task title")?;
    let priority = request.priority.as_deref().unwrap_or("medium");
    validate_priority(priority)?;
    let tags = serde_json::to_string(request.tags.as_deref().unwrap_or(&[]))?;
    let id = uuid::Uuid::new_v4().to_string();

    conn.execute(
        "INSERT INTO tasks (id, title, priority, status, tags, project_id, created_at)
         VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6)",
        rusqlite::params![
            &id,
            title,
            priority,
            tags,
            request.project_id.as_deref(),
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(id)
}

pub fn update_task(conn: &Connection, id: &str, request: &UpdateTaskRequest) -> ApiResult<()> {
    let current_status = task_status(conn, id)?;
    let now = Utc::now().to_rfc3339();

    let mut updates: Vec<&str> = Vec::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(title) = &request.title {
        let title = required_text(title, "Task title")?;
        updates.push("title = ?");
        params.push(Box::new(title.to_string()));
    }
    if let Some(priority) = &request.priority {
        validate_priority(priority)?;
        updates.push("priority = ?");
        params.push(Box::new(priority.to_string()));
    }
    if let Some(tags) = &request.tags {
        updates.push("tags = ?");
        params.push(Box::new(serde_json::to_string(tags)?));
    }
    if let Some(project_id) = &request.project_id {
        updates.push("project_id = ?");
        params.push(Box::new(project_id.clone()));
    }

    if let Some(status) = request.status.as_deref() {
        validate_status(status)?;
        // 状态未变时保留开始/完成时间，避免编辑已完成任务时改写历史。
        if status != current_status {
            apply_status_transition(status, &now, request, &mut updates, &mut params);
        }
    }

    if let Some(blocked_reason) = &request.blocked_reason {
        updates.push("blocked_reason = ?");
        params.push(Box::new(blocked_reason.clone()));
    }
    if let Some(result) = &request.result {
        updates.push("result = ?");
        params.push(Box::new(result.clone()));
    }

    if updates.is_empty() {
        return Ok(());
    }

    updates.push("updated_at = ?");
    params.push(Box::new(Utc::now().to_rfc3339()));
    params.push(Box::new(id.to_string()));

    let sql = format!("UPDATE tasks SET {} WHERE id = ?", updates.join(", "));
    let params: Vec<&dyn ToSql> = params.iter().map(|param| param.as_ref()).collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

fn apply_status_transition(
    status: &str,
    now: &str,
    request: &UpdateTaskRequest,
    updates: &mut Vec<&'static str>,
    params: &mut Vec<Box<dyn ToSql>>,
) {
    match status {
        "pending" => {
            updates.push("started_at = NULL");
            updates.push("finished_at = NULL");
            if request.blocked_reason.is_none() {
                updates.push("blocked_reason = NULL");
            }
        }
        "in_progress" => {
            updates.push("started_at = COALESCE(started_at, ?)");
            params.push(Box::new(now.to_string()));
            updates.push("finished_at = NULL");
            if request.blocked_reason.is_none() {
                updates.push("blocked_reason = NULL");
            }
        }
        "blocked" => {
            updates.push("finished_at = NULL");
        }
        "done" => {
            updates.push("started_at = COALESCE(started_at, ?)");
            params.push(Box::new(now.to_string()));
            updates.push("finished_at = ?");
            params.push(Box::new(now.to_string()));
            if request.blocked_reason.is_none() {
                updates.push("blocked_reason = NULL");
            }
        }
        "cancelled" => {
            updates.push("finished_at = ?");
            params.push(Box::new(now.to_string()));
        }
        _ => unreachable!("validated status"),
    }
    updates.push("status = ?");
    params.push(Box::new(status.to_string()));
}

pub fn delete_task(conn: &Connection, id: &str) -> ApiResult<()> {
    ensure_task_exists(conn, id)?;
    conn.execute("DELETE FROM tasks WHERE id = ?", [id])?;
    Ok(())
}

struct PeriodRange {
    start: String,
    end: String,
}

fn period_range(period: &str) -> Option<PeriodRange> {
    let now = Utc::now();
    let start: NaiveDate = match period {
        "daily" => now.date_naive(),
        "weekly" => {
            (now - Duration::days(now.weekday().num_days_from_monday() as i64)).date_naive()
        }
        "monthly" => NaiveDate::from_ymd_opt(now.year(), now.month(), 1)?,
        _ => return None,
    };
    Some(PeriodRange {
        start: format!("{start} 00:00:00"),
        end: format!("{} 23:59:59", now.date_naive()),
    })
}

fn ensure_project_exists(conn: &Connection, id: &str) -> ApiResult<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?)",
        [id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("Project {id} not found")))
    }
}

fn task_status(conn: &Connection, id: &str) -> ApiResult<String> {
    conn.query_row("SELECT status FROM tasks WHERE id = ?", [id], |row| {
        row.get(0)
    })
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("Task {id} not found")),
        other => AppError::Internal(other.into()),
    })
}

fn ensure_task_exists(conn: &Connection, id: &str) -> ApiResult<()> {
    task_status(conn, id).map(|_| ())
}

fn validate_priority(priority: &str) -> ApiResult<()> {
    if PRIORITIES.contains(&priority) {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "Invalid priority: {priority}"
        )))
    }
}

fn validate_status(status: &str) -> ApiResult<()> {
    if STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!("Invalid status: {status}")))
    }
}

fn required_text<'a>(value: &'a str, field: &str) -> ApiResult<&'a str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(AppError::BadRequest(format!("{field} is required")))
    } else {
        Ok(trimmed)
    }
}

fn optional_text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn parse_datetime(value: &str) -> DateTime<Utc> {
    parse_datetime_opt(value).unwrap_or_else(Utc::now)
}

fn parse_datetime_opt(value: &str) -> Option<DateTime<Utc>> {
    let formats = [
        "%Y-%m-%dT%H:%M:%S%.f%:z",
        "%Y-%m-%dT%H:%M:%S%:z",
        "%Y-%m-%d %H:%M:%S",
    ];
    for format in formats {
        if let Ok(parsed) = DateTime::parse_from_str(value, format) {
            return Some(parsed.with_timezone(&Utc));
        }
    }

    let with_timezone = format!("{}+00:00", value.replace(' ', "T"));
    for format in ["%Y-%m-%dT%H:%M:%S%.f%:z", "%Y-%m-%dT%H:%M:%S%:z"] {
        if let Ok(parsed) = DateTime::parse_from_str(&with_timezone, format) {
            return Some(parsed.with_timezone(&Utc));
        }
    }
    None
}
