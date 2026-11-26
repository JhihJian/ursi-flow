use serde::{Deserialize, Deserializer, Serialize};

/// 任务与项目的实体定义来自 SUMM-Todo 的 `todo-core`，看板不再自定义字段。
pub use todo_core::{Creator, Priority, Project, Status, Task};

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    pub priority: Option<Priority>,
    pub tags: Option<Vec<String>>,
    pub project_id: Option<String>,
    /// 直接建成某任务的子任务。
    pub parent_id: Option<String>,
    /// 新建时一并写入的过程记录，空文本视为未填写。
    pub log: Option<String>,
    /// 新建时一并写入的工作结果，空文本视为未填写。
    pub result: Option<String>,
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
    pub parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub pre_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub blocked_reason: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub result: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub log: Option<Option<String>>,
}

/// 追加一段工作结果，服务端以空行分隔拼接到已有结果之后。
#[derive(Debug, Deserialize)]
pub struct AppendResultRequest {
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct AppendResultResponse {
    pub result: String,
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

/// 某一天创建的任务数，用于近七天的分布条。
#[derive(Debug, Serialize, Deserialize)]
pub struct DayCount {
    pub date: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct DailyStatsResponse {
    pub days: Vec<DayCount>,
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
