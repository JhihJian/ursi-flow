use serde::{Deserialize, Deserializer, Serialize};

/// 任务与项目的实体定义来自 SUMM-Todo 的 `todo-core`，看板不再自定义字段。
pub use todo_core::{Creator, Priority, Project, Status, Task};

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    pub priority: Option<Priority>,
    pub tags: Option<Vec<String>>,
    pub project_id: Option<String>,
}

/// 省略字段表示不改，显式 `null` 表示清空。
#[derive(Debug, Deserialize)]
pub struct UpdateTaskRequest {
    pub title: Option<String>,
    pub priority: Option<Priority>,
    pub status: Option<Status>,
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub project_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub blocked_reason: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub result: Option<Option<String>>,
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
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub path: Option<Option<String>>,
}

/// 状态计数覆盖 `todo_core::Status` 的全部取值。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskCount {
    pub pending: i64,
    pub in_progress: i64,
    pub blocked: i64,
    pub done: i64,
    pub cancelled: i64,
}

#[derive(Debug, Serialize)]
pub struct ProjectStats {
    #[serde(flatten)]
    pub project: Project,
    pub task_count: TaskCount,
    pub total_time_minutes: i64,
}

#[derive(Debug, Serialize)]
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

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
