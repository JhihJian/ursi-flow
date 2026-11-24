use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub priority: String,
    pub status: String,
    pub tags: Vec<String>,
    pub project_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub blocked_reason: Option<String>,
    pub result: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    pub priority: Option<String>,
    pub tags: Option<Vec<String>>,
    pub project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTaskRequest {
    pub title: Option<String>,
    pub priority: Option<String>,
    pub status: Option<String>,
    pub tags: Option<Vec<String>>,
    /// `None` 表示未提交该字段，`Some(None)` 表示显式清空。
    pub project_id: Option<Option<String>>,
    pub blocked_reason: Option<Option<String>>,
    pub result: Option<Option<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub description: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    /// `None` 表示未提交该字段，`Some(None)` 表示显式清空。
    pub description: Option<Option<String>>,
    pub path: Option<Option<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectStats {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub path: Option<String>,
    pub task_count: TaskCount,
    pub total_time_minutes: i64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct TaskCount {
    pub pending: i64,
    pub in_progress: i64,
    pub blocked: i64,
    pub done: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Stats {
    pub period: String,
    pub start: String,
    pub end: String,
    pub total_tasks: i64,
    pub total_time_minutes: i64,
    pub by_status: TaskCount,
}

#[derive(Debug, Serialize)]
pub struct ProjectsResponse {
    pub projects: Vec<ProjectStats>,
}

#[derive(Debug, Serialize)]
pub struct TasksResponse {
    pub tasks: Vec<Task>,
}

#[derive(Debug, Serialize)]
pub struct StatsResponse {
    pub stats: Stats,
}

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub id: String,
}

#[derive(Debug, Serialize)]
pub struct SuccessResponse {
    pub success: bool,
}
