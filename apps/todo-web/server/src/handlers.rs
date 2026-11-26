use crate::db::{self, Columns};
use crate::models::{
    AppendResultRequest, AppendResultResponse, CreateProjectRequest, CreateResponse,
    CreateTaskRequest, DailyStatsResponse, DayCount, Priority, Project, ProjectStats,
    ProjectsResponse, Stats, StatsResponse, Status, SuccessResponse, Task, TaskCount, TasksResponse,
    UpdateProjectRequest, UpdateTaskRequest,
};
use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Json},
};
use chrono::{Datelike, Duration, NaiveDate, Utc};
use rusqlite::{Connection, ToSql};
use serde::Deserialize;
use std::collections::HashMap;
use std::str::FromStr;
use todo_core::{TodoError, TransitionContext};

/// 已完成与已取消的任务都带完成时间，其余状态属于未完成。
const TERMINAL_STATUSES: &str = "('done', 'cancelled')";

pub type ApiResult<T> = Result<T, AppError>;

#[derive(Debug)]
pub enum AppError {
    BadRequest {
        code: &'static str,
        message: String,
    },
    NotFound(String),
    Internal(anyhow::Error),
}

impl AppError {
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::BadRequest {
            code: "E_INVALID_INPUT",
            message: message.into(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, code, message) = match self {
            AppError::BadRequest { code, message } => (StatusCode::BAD_REQUEST, code, message),
            AppError::NotFound(message) => (StatusCode::NOT_FOUND, "E_NOT_FOUND", message),
            AppError::Internal(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "E_INTERNAL",
                error.to_string(),
            ),
        };
        (
            status,
            Json(serde_json::json!({ "error": message, "code": code })),
        )
            .into_response()
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

/// 状态机与输入校验的错误码沿用 SUMM-Todo，前端可直接展示 `error` 文案。
impl From<TodoError> for AppError {
    fn from(error: TodoError) -> Self {
        match error {
            TodoError::TaskNotFound(_) | TodoError::ProjectNotFound(_) => {
                Self::NotFound(error.to_string())
            }
            TodoError::Database(inner) => Self::Internal(inner.into()),
            other => Self::BadRequest {
                code: other.code(),
                message: other.to_string(),
            },
        }
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
    /// 逗号分隔的 `YYYY-MM-DD`，按创建日期过滤，可多选。与 `period` 互斥，由调用方决定用哪个。
    pub dates: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DailyStatsQuery {
    pub project: Option<String>,
    pub days: Option<i64>,
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
        query.dates.as_deref(),
    )?;
    Ok(Json(TasksResponse { tasks }))
}

pub async fn get_daily_stats(
    Query(query): Query<DailyStatsQuery>,
) -> ApiResult<Json<DailyStatsResponse>> {
    let conn = db::connect()?;
    let days = daily_task_counts(&conn, query.project.as_deref(), query.days.unwrap_or(7))?;
    Ok(Json(DailyStatsResponse { days }))
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

/// `POST /api/tasks/{id}/result/append`：把一段工作结果追加到已有结果之后。
pub async fn post_task_result(
    Path(id): Path<String>,
    Json(request): Json<AppendResultRequest>,
) -> ApiResult<Json<AppendResultResponse>> {
    let conn = db::connect()?;
    let result = append_task_result(&conn, &id, &request.text)?;
    Ok(Json(AppendResultResponse { result }))
}

pub async fn remove_task(Path(id): Path<String>) -> ApiResult<Json<SuccessResponse>> {
    let conn = db::connect()?;
    delete_task(&conn, &id)?;
    Ok(Json(SuccessResponse { success: true }))
}

pub fn fetch_projects(conn: &Connection, active_only: bool) -> ApiResult<Vec<ProjectStats>> {
    let columns = Columns::load(conn, "projects", &db::PROJECT_FIELDS)?;
    let mut statement = conn.prepare(&format!(
        "SELECT {} FROM projects ORDER BY created_at DESC",
        columns.select_list()
    ))?;
    let projects = statement
        .query_map([], |row| db::read_project(row, &columns))?
        .collect::<Result<Vec<_>, _>>()?;

    let counts = project_task_counts(conn)?;
    let minutes = project_minutes(conn)?;

    let mut stats = projects
        .into_iter()
        .map(|project| ProjectStats {
            task_count: counts.get(&project.id).cloned().unwrap_or_default(),
            total_time_minutes: minutes.get(&project.id).copied().unwrap_or(0),
            project,
        })
        .collect::<Vec<_>>();

    if active_only {
        stats.retain(|stat| {
            stat.task_count.pending > 0
                || stat.task_count.in_progress > 0
                || stat.task_count.blocked > 0
        });
    }

    stats.sort_by_key(|stat| std::cmp::Reverse(active_count(stat)));

    Ok(stats)
}

pub fn fetch_tasks(
    conn: &Connection,
    project: Option<&str>,
    status: Option<&str>,
    period: Option<&str>,
    dates: Option<&str>,
) -> ApiResult<Vec<Task>> {
    let status = match status {
        Some(value) => Some(Status::from_str(value)?),
        None => None,
    };

    let columns = Columns::load(conn, "tasks", &db::TASK_FIELDS)?;
    let mut sql = format!(
        "SELECT {} FROM tasks WHERE 1 = 1",
        columns.select_list()
    );
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(project) = project {
        sql.push_str(" AND project_id = ?");
        params.push(Box::new(project.to_string()));
    }

    if let Some(status) = &status {
        sql.push_str(" AND status = ?");
        params.push(Box::new(status.to_string()));
    }

    if let Some(dates) = dates {
        let mut days = Vec::new();
        for value in dates.split(',').map(str::trim).filter(|value| !value.is_empty()) {
            days.push(parse_date(value)?.to_string());
        }
        if !days.is_empty() {
            let placeholders = vec!["?"; days.len()].join(", ");
            sql.push_str(&format!(
                " AND date(datetime(replace(created_at, 'T', ' '))) IN ({placeholders})"
            ));
            for day in days {
                params.push(Box::new(day));
            }
        }
    }

    if let Some(range) = period.and_then(period_range) {
        // 只按完成时间过滤已完成任务，未完成任务始终可见。
        sql.push_str(&format!(
            " AND (status NOT IN {TERMINAL_STATUSES} OR (
                  finished_at IS NOT NULL
                  AND datetime(replace(finished_at, 'T', ' ')) BETWEEN datetime(?) AND datetime(?)))"
        ));
        params.push(Box::new(range.start));
        params.push(Box::new(range.end));
    }

    sql.push_str(&format!(
        " ORDER BY
            CASE WHEN status IN {TERMINAL_STATUSES} THEN 1 ELSE 0 END,
            CASE WHEN status IN {TERMINAL_STATUSES} THEN NULL
                 ELSE CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
            END,
            CASE WHEN status IN {TERMINAL_STATUSES} THEN NULL ELSE created_at END ASC,
            finished_at DESC"
    ));

    let params: Vec<&dyn ToSql> = params.iter().map(|param| param.as_ref()).collect();
    let mut statement = conn.prepare(&sql)?;
    let tasks = statement
        .query_map(params.as_slice(), |row| db::read_task(row, &columns))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(tasks)
}

/// 最近 `days` 天每天创建的任务数，缺失的日期补 0。
pub fn daily_task_counts(
    conn: &Connection,
    project: Option<&str>,
    days: i64,
) -> ApiResult<Vec<DayCount>> {
    let days = days.clamp(1, 31);
    let today = Utc::now().date_naive();
    let start = today - Duration::days(days - 1);

    let mut sql = String::from(
        "SELECT date(datetime(replace(created_at, 'T', ' '))) AS day, COUNT(*)
         FROM tasks
         WHERE date(datetime(replace(created_at, 'T', ' '))) BETWEEN date(?) AND date(?)",
    );
    let mut params: Vec<Box<dyn ToSql>> = vec![
        Box::new(start.to_string()),
        Box::new(today.to_string()),
    ];
    if let Some(project) = project {
        sql.push_str(" AND project_id = ?");
        params.push(Box::new(project.to_string()));
    }
    sql.push_str(" GROUP BY day");

    let params: Vec<&dyn ToSql> = params.iter().map(|param| param.as_ref()).collect();
    let mut statement = conn.prepare(&sql)?;
    let counted: HashMap<String, i64> = statement
        .query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<_, _>>()?;

    let days = (0..days)
        .map(|offset| {
            let date = (start + Duration::days(offset)).to_string();
            let count = counted.get(&date).copied().unwrap_or(0);
            DayCount { date, count }
        })
        .collect();
    Ok(days)
}

fn parse_date(value: &str) -> ApiResult<NaiveDate> {
    NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::invalid_input(format!("Invalid date: {value}")))
}

pub fn calculate_stats(conn: &Connection, period: &str) -> ApiResult<Stats> {
    let range = period_range(period)
        .ok_or_else(|| AppError::invalid_input(format!("Unknown period: {period}")))?;

    let done_in_period = "FROM tasks
         WHERE status = 'done' AND finished_at IS NOT NULL
           AND datetime(replace(finished_at, 'T', ' ')) BETWEEN datetime(?1) AND datetime(?2)";

    let total_tasks: i64 =
        conn.query_row(&format!("SELECT COUNT(*) {done_in_period}"), [&range.start, &range.end], |row| {
            row.get(0)
        })?;

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

    let count_status = |status: Status| -> ApiResult<i64> {
        // 终态按完成时间落周期，其余按创建时间。
        let column = match status {
            Status::Done | Status::Cancelled => "finished_at",
            _ => "created_at",
        };
        Ok(conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM tasks
                 WHERE status = ?1 AND {column} IS NOT NULL
                   AND datetime(replace({column}, 'T', ' ')) BETWEEN datetime(?2) AND datetime(?3)"
            ),
            rusqlite::params![status.to_string(), range.start, range.end],
            |row| row.get(0),
        )?)
    };

    let by_status = TaskCount {
        pending: count_status(Status::Pending)?,
        in_progress: count_status(Status::InProgress)?,
        blocked: count_status(Status::Blocked)?,
        done: total_tasks,
        cancelled: count_status(Status::Cancelled)?,
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
    let name = required_text(&request.name, "Project name")?.to_string();
    let columns = Columns::load(conn, "projects", &db::PROJECT_FIELDS)?;
    let mut project = Project::new(todo_core::generate_id(conn)?, name);
    project.description = optional_text(request.description.as_deref()).map(str::to_string);
    project.path = optional_text(request.path.as_deref()).map(str::to_string);
    db::insert_project(conn, &project, &columns)?;
    Ok(project.id)
}

pub fn update_project(
    conn: &Connection,
    id: &str,
    request: &UpdateProjectRequest,
) -> ApiResult<()> {
    let columns = Columns::load(conn, "projects", &db::PROJECT_FIELDS)?;
    let mut project = read_project_by_id(conn, &columns, id)?;

    if let Some(name) = &request.name {
        project.name = required_text(name, "Project name")?.to_string();
    }
    if let Some(description) = &request.description {
        project.description = optional_text(description.as_deref()).map(str::to_string);
    }
    if let Some(path) = &request.path {
        project.path = optional_text(path.as_deref()).map(str::to_string);
    }

    db::update_project_row(conn, &project, &columns)?;
    Ok(())
}

pub fn delete_project(conn: &Connection, id: &str) -> ApiResult<()> {
    let columns = Columns::load(conn, "projects", &db::PROJECT_FIELDS)?;
    read_project_by_id(conn, &columns, id)?;
    conn.execute(
        "UPDATE tasks SET project_id = NULL WHERE project_id = ?",
        [id],
    )?;
    conn.execute("DELETE FROM projects WHERE id = ?", [id])?;
    Ok(())
}

pub fn create_task(conn: &Connection, request: &CreateTaskRequest) -> ApiResult<String> {
    let title = required_text(&request.title, "Task title")?.to_string();
    let columns = Columns::load(conn, "tasks", &db::TASK_FIELDS)?;
    if let Some(project_id) = &request.project_id {
        ensure_project_exists(conn, project_id)?;
    }

    let mut task = Task::new(todo_core::generate_id(conn)?, title);
    task.priority = request.priority.clone().unwrap_or(Priority::Medium);
    task.tags = request.tags.clone().unwrap_or_default();
    task.project_id = request.project_id.clone();
    db::insert_task(conn, &task, &columns)?;
    Ok(task.id)
}

pub fn update_task(conn: &Connection, id: &str, request: &UpdateTaskRequest) -> ApiResult<()> {
    let columns = Columns::load(conn, "tasks", &db::TASK_FIELDS)?;
    let mut task = read_task_by_id(conn, &columns, id)?;

    if let Some(title) = &request.title {
        task.title = required_text(title, "Task title")?.to_string();
    }
    if let Some(priority) = &request.priority {
        task.priority = priority.clone();
    }
    if let Some(tags) = &request.tags {
        task.tags = tags.clone();
    }
    if let Some(project_id) = &request.project_id {
        if let Some(project_id) = project_id {
            ensure_project_exists(conn, project_id)?;
        }
        task.project_id = project_id.clone();
    }

    // 关系字段直接写回，调用方负责不让图成环；指向不存在的任务直接拒绝。
    if let Some(parent_id) = &request.parent_id {
        task.parent_id = relation_target(conn, &columns, "parent_id", id, parent_id.as_deref())?;
    }
    if let Some(pre_id) = &request.pre_id {
        task.pre_id = relation_target(conn, &columns, "pre_id", id, pre_id.as_deref())?;
    }

    // 状态迁移交给 todo-core 的状态机，看板不重复实现规则。
    if let Some(status) = request.status.clone() {
        task.transition(
            status,
            TransitionContext {
                result: request.result.clone().flatten(),
                blocked_reason: request.blocked_reason.clone().flatten(),
                ..Default::default()
            },
        )?;
    }

    if let Some(result) = &request.result {
        task.result = result.clone();
    }
    if let Some(log) = &request.log {
        task.log = log.clone();
    }
    if let Some(blocked_reason) = &request.blocked_reason {
        task.blocked_reason = blocked_reason.clone();
    }

    db::update_task_row(conn, &task, &columns)?;
    Ok(())
}

/// 追加工作结果，拼接规则由 `todo_core::Task::append_result` 定义。
pub fn append_task_result(conn: &Connection, id: &str, text: &str) -> ApiResult<String> {
    let columns = Columns::load(conn, "tasks", &db::TASK_FIELDS)?;
    if !columns.has("result") {
        return Err(AppError::Internal(anyhow::anyhow!(
            "待办库缺少 result 列，无法追加结果"
        )));
    }
    let mut task = read_task_by_id(conn, &columns, id)?;
    task.append_result(text)?;
    db::update_task_row(conn, &task, &columns)?;
    Ok(task.result.unwrap_or_default())
}

pub fn delete_task(conn: &Connection, id: &str) -> ApiResult<()> {
    let columns = Columns::load(conn, "tasks", &db::TASK_FIELDS)?;
    read_task_by_id(conn, &columns, id)?;
    conn.execute("DELETE FROM tasks WHERE id = ?", [id])?;
    Ok(())
}

fn active_count(stat: &ProjectStats) -> i64 {
    stat.task_count.pending + stat.task_count.in_progress + stat.task_count.blocked
}

fn project_task_counts(conn: &Connection) -> ApiResult<HashMap<String, TaskCount>> {
    let mut statement = conn.prepare(
        "SELECT project_id, status, COUNT(*) FROM tasks
         WHERE project_id IS NOT NULL
         GROUP BY project_id, status",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut counts: HashMap<String, TaskCount> = HashMap::new();
    for (project_id, status, count) in rows {
        let entry = counts.entry(project_id).or_default();
        match status.as_str() {
            "pending" => entry.pending += count,
            "in_progress" => entry.in_progress += count,
            "blocked" => entry.blocked += count,
            "done" => entry.done += count,
            "cancelled" => entry.cancelled += count,
            _ => {}
        }
    }
    Ok(counts)
}

fn project_minutes(conn: &Connection) -> ApiResult<HashMap<String, i64>> {
    let mut statement = conn.prepare(
        "SELECT project_id, COALESCE(SUM(
             CAST((julianday(replace(finished_at, 'T', ' '))
                  - julianday(replace(started_at, 'T', ' '))) * 24 * 60 AS INTEGER)
         ), 0)
         FROM tasks
         WHERE project_id IS NOT NULL
           AND status = 'done'
           AND started_at IS NOT NULL AND finished_at IS NOT NULL
         GROUP BY project_id",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().collect())
}

struct PeriodRange {
    start: String,
    end: String,
}

fn period_range(period: &str) -> Option<PeriodRange> {
    let now = Utc::now();
    let today = now.date_naive();
    let start: NaiveDate = match period {
        "all" => NaiveDate::from_ymd_opt(1970, 1, 1)?,
        "daily" => today,
        "weekly" => today - Duration::days(now.weekday().num_days_from_monday() as i64),
        "monthly" => NaiveDate::from_ymd_opt(now.year(), now.month(), 1)?,
        _ => return None,
    };
    Some(PeriodRange {
        start: format!("{start} 00:00:00"),
        end: format!("{today} 23:59:59"),
    })
}

fn read_task_by_id(conn: &Connection, columns: &Columns, id: &str) -> ApiResult<Task> {
    let mut statement = conn.prepare(&format!(
        "SELECT {} FROM tasks WHERE id = ?1",
        columns.select_list()
    ))?;
    let mut rows = statement.query([id])?;
    match rows.next()? {
        Some(row) => Ok(db::read_task(row, columns)?),
        None => Err(AppError::NotFound(format!("Task {id} not found"))),
    }
}

fn read_project_by_id(conn: &Connection, columns: &Columns, id: &str) -> ApiResult<Project> {
    let mut statement = conn.prepare(&format!(
        "SELECT {} FROM projects WHERE id = ?1",
        columns.select_list()
    ))?;
    let mut rows = statement.query([id])?;
    match rows.next()? {
        Some(row) => Ok(db::read_project(row, columns)?),
        None => Err(AppError::NotFound(format!("Project {id} not found"))),
    }
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

fn required_text<'a>(value: &'a str, field: &str) -> ApiResult<&'a str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(AppError::invalid_input(format!("{field} is required")))
    } else {
        Ok(trimmed)
    }
}

/// 关系字段的写入：`null` 是清空，指向自身或缺失任务直接拒绝，缺列时报错不静默丢弃。
fn relation_target(
    conn: &Connection,
    columns: &Columns,
    field: &str,
    id: &str,
    target: Option<&str>,
) -> ApiResult<Option<String>> {
    let Some(target) = target else { return Ok(None) };
    if target == id {
        return Err(AppError::invalid_input(format!(
            "{field} cannot point at the task itself"
        )));
    }
    if !columns.has(field) {
        return Err(AppError::Internal(anyhow::anyhow!(
            "待办库缺少 {field} 列，无法保存任务关系"
        )));
    }
    read_task_by_id(conn, columns, target)?;
    Ok(Some(target.to_string()))
}

fn optional_text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}
