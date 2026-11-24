use chrono::{Duration, Utc};
use rusqlite::Connection;
use todo_web_server::db::{self, Columns};
use todo_web_server::handlers::{
    calculate_stats, create_project, create_task, daily_task_counts, delete_project, delete_task,
    fetch_projects, fetch_tasks, update_project, update_task, AppError,
};
use todo_web_server::models::{
    CreateProjectRequest, CreateTaskRequest, Priority, Status, UpdateProjectRequest,
    UpdateTaskRequest,
};

/// 与 SUMM-Todo CLI v6 建出的库一致。
fn setup() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            description TEXT,
            path TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            creator TEXT NOT NULL DEFAULT 'human',
            created_at TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'medium',
            tags TEXT DEFAULT '[]',
            parent_id TEXT,
            pre_id TEXT,
            due TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            assignee TEXT,
            blocked_reason TEXT,
            result TEXT,
            artifacts TEXT DEFAULT '[]',
            log TEXT,
            started_at TEXT,
            finished_at TEXT,
            content TEXT,
            project_id TEXT,
            updated_at TEXT,
            workspace TEXT,
            session_id TEXT
        );",
    )
    .unwrap();
    conn
}

/// 早期版本 CLI 的库，缺少后来加入的列。
fn setup_legacy() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'medium',
            status TEXT NOT NULL DEFAULT 'pending',
            tags TEXT DEFAULT '[]',
            parent_id TEXT,
            project_id TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            blocked_reason TEXT,
            result TEXT
        );",
    )
    .unwrap();
    conn
}

fn insert_project(conn: &Connection, id: &str, name: &str) {
    conn.execute(
        "INSERT INTO projects (id, name, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, name, Utc::now().to_rfc3339()],
    )
    .unwrap();
}

fn insert_task(conn: &Connection, id: &str, project: &str, status: &str, priority: &str) {
    conn.execute(
        "INSERT INTO tasks (id, title, priority, status, project_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            id,
            format!("Task {id}"),
            priority,
            status,
            project,
            Utc::now().to_rfc3339()
        ],
    )
    .unwrap();
}

fn update(_id: &str) -> UpdateTaskRequest {
    UpdateTaskRequest {
        title: None,
        priority: None,
        status: None,
        tags: None,
        project_id: None,
        blocked_reason: None,
        result: None,
        workspace: None,
        session_id: None,
    }
}

#[test]
fn empty_database_returns_empty_lists_and_zero_stats() {
    let conn = setup();
    assert!(fetch_projects(&conn, false).unwrap().is_empty());
    assert!(fetch_tasks(&conn, None, None, None, None).unwrap().is_empty());
    let stats = calculate_stats(&conn, "daily").unwrap();
    assert_eq!(stats.total_tasks, 0);
    assert_eq!(stats.total_time_minutes, 0);
}

#[test]
fn projects_carry_status_counts_and_total_time() {
    let conn = setup();
    insert_project(&conn, "proj-a", "Alpha");
    insert_project(&conn, "proj-b", "Beta");
    insert_task(&conn, "t1", "proj-a", "pending", "high");
    insert_task(&conn, "t2", "proj-a", "in_progress", "medium");
    insert_task(&conn, "t3", "proj-a", "blocked", "low");
    insert_task(&conn, "t4", "proj-a", "done", "medium");
    insert_task(&conn, "t5", "proj-a", "cancelled", "low");

    let started = Utc::now() - Duration::minutes(90);
    conn.execute(
        "UPDATE tasks SET started_at = ?1, finished_at = ?2 WHERE id = 't4'",
        rusqlite::params![started.to_rfc3339(), Utc::now().to_rfc3339()],
    )
    .unwrap();

    let projects = fetch_projects(&conn, false).unwrap();
    assert_eq!(projects.len(), 2);
    let alpha = projects
        .iter()
        .find(|stat| stat.project.id == "proj-a")
        .unwrap();
    assert_eq!(alpha.task_count.pending, 1);
    assert_eq!(alpha.task_count.in_progress, 1);
    assert_eq!(alpha.task_count.blocked, 1);
    assert_eq!(alpha.task_count.done, 1);
    assert_eq!(alpha.task_count.cancelled, 1);
    assert!(
        (89..=90).contains(&alpha.total_time_minutes),
        "{}",
        alpha.total_time_minutes
    );

    let active = fetch_projects(&conn, true).unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].project.id, "proj-a");
}

#[test]
fn tasks_filter_by_project_status_and_period() {
    let conn = setup();
    insert_project(&conn, "proj-a", "Alpha");
    insert_project(&conn, "proj-b", "Beta");
    insert_task(&conn, "pending-a", "proj-a", "pending", "high");
    insert_task(&conn, "done-a", "proj-a", "done", "medium");
    insert_task(&conn, "done-b", "proj-b", "done", "low");

    conn.execute(
        "UPDATE tasks SET started_at = ?1, finished_at = ?2 WHERE id = 'done-a'",
        rusqlite::params![
            (Utc::now() - Duration::minutes(30)).to_rfc3339(),
            Utc::now().to_rfc3339()
        ],
    )
    .unwrap();
    conn.execute(
        "UPDATE tasks SET started_at = ?1, finished_at = ?2 WHERE id = 'done-b'",
        rusqlite::params![
            (Utc::now() - Duration::days(40)).to_rfc3339(),
            (Utc::now() - Duration::days(40)).to_rfc3339()
        ],
    )
    .unwrap();

    let project_tasks = fetch_tasks(&conn, Some("proj-a"), None, None, None).unwrap();
    assert_eq!(project_tasks.len(), 2);

    let done_tasks = fetch_tasks(&conn, None, Some("done"), None, None).unwrap();
    assert_eq!(done_tasks.len(), 2);

    let daily = fetch_tasks(&conn, Some("proj-a"), None, Some("daily"), None).unwrap();
    assert_eq!(daily.len(), 2);
    let ids: Vec<_> = daily.iter().map(|task| task.id.as_str()).collect();
    assert!(ids.contains(&"pending-a"));
    assert!(ids.contains(&"done-a"));

    let daily_b = fetch_tasks(&conn, Some("proj-b"), None, Some("daily"), None).unwrap();
    assert!(daily_b.is_empty());

    let unknown = fetch_tasks(&conn, None, Some("archived"), None, None).unwrap_err();
    assert!(matches!(unknown, AppError::BadRequest { .. }));
}

#[test]
fn daily_and_all_stats_count_done_tasks_and_minutes() {
    let conn = setup();
    insert_project(&conn, "proj-a", "Alpha");
    insert_task(&conn, "t1", "proj-a", "done", "medium");
    conn.execute(
        "UPDATE tasks SET started_at = ?1, finished_at = ?2 WHERE id = 't1'",
        rusqlite::params![
            (Utc::now() - Duration::minutes(45)).to_rfc3339(),
            Utc::now().to_rfc3339()
        ],
    )
    .unwrap();

    let stats = calculate_stats(&conn, "daily").unwrap();
    assert_eq!(stats.total_tasks, 1);
    assert!(
        (44..=45).contains(&stats.total_time_minutes),
        "{}",
        stats.total_time_minutes
    );
    assert_eq!(stats.by_status.done, 1);

    let all_time = calculate_stats(&conn, "all").unwrap();
    assert_eq!(all_time.period, "all");
    assert_eq!(all_time.total_tasks, 1);

    let unknown = calculate_stats(&conn, "yearly").unwrap_err();
    assert!(matches!(unknown, AppError::BadRequest { .. }));
}

#[test]
fn cancelled_tasks_count_in_stats_but_not_in_active_projects() {
    let conn = setup();
    insert_project(&conn, "proj-a", "Alpha");
    insert_task(&conn, "t1", "proj-a", "cancelled", "low");
    conn.execute(
        "UPDATE tasks SET finished_at = ?1 WHERE id = 't1'",
        rusqlite::params![Utc::now().to_rfc3339()],
    )
    .unwrap();

    let stats = calculate_stats(&conn, "daily").unwrap();
    assert_eq!(stats.by_status.cancelled, 1);
    assert_eq!(stats.total_tasks, 0);
    assert!(fetch_projects(&conn, true).unwrap().is_empty());
}

#[test]
fn project_crud_keeps_tasks_when_deleting() {
    let conn = setup();
    let id = create_project(
        &conn,
        &CreateProjectRequest {
            name: "  Alpha  ".into(),
            description: Some(" first ".into()),
            path: Some("/tmp/alpha".into()),
        },
    )
    .unwrap();
    let project = fetch_projects(&conn, false).unwrap().remove(0).project;
    assert_eq!(project.name, "Alpha");
    assert_eq!(project.description.as_deref(), Some("first"));
    assert_eq!(project.path.as_deref(), Some("/tmp/alpha"));

    update_project(
        &conn,
        &id,
        &UpdateProjectRequest {
            name: None,
            description: Some(None),
            path: Some(None),
        },
    )
    .unwrap();
    let project = fetch_projects(&conn, false).unwrap().remove(0).project;
    assert!(project.description.is_none());
    assert!(project.path.is_none());

    insert_task(&conn, "t1", &id, "pending", "high");
    delete_project(&conn, &id).unwrap();
    assert!(fetch_projects(&conn, false).unwrap().is_empty());
    let task = fetch_tasks(&conn, None, None, None, None).unwrap().remove(0);
    assert!(task.project_id.is_none());
}

#[test]
fn task_create_update_and_delete() {
    let conn = setup();
    insert_project(&conn, "proj-a", "Alpha");
    insert_project(&conn, "proj-b", "Beta");
    let id = create_task(
        &conn,
        &CreateTaskRequest {
            title: "Write spec".into(),
            priority: Some(Priority::High),
            tags: Some(vec!["docs".into()]),
            project_id: Some("proj-a".into()),
            workspace: Some("  wb-alpha  ".into()),
            session_id: Some("sess-42".into()),
        },
    )
    .unwrap();

    let task = fetch_tasks(&conn, None, None, None, None).unwrap().remove(0);
    assert_eq!(task.status, Status::Pending);
    assert_eq!(task.priority, Priority::High);
    assert_eq!(task.tags, vec!["docs".to_string()]);
    assert_eq!(task.workspace.as_deref(), Some("wb-alpha"));
    assert_eq!(task.session_id.as_deref(), Some("sess-42"));

    update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            status: Some(Status::InProgress),
            ..update(&id)
        },
    )
    .unwrap();
    let task = fetch_tasks(&conn, None, None, None, None).unwrap().remove(0);
    assert!(task.started_at.is_some());
    assert!(task.finished_at.is_none());

    update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            title: Some("Write docs".into()),
            status: Some(Status::Done),
            project_id: Some(Some("proj-b".into())),
            result: Some(Some("shipped".into())),
            ..update(&id)
        },
    )
    .unwrap();
    let task = fetch_tasks(&conn, None, None, None, None).unwrap().remove(0);
    assert_eq!(task.title, "Write docs");
    assert_eq!(task.status, Status::Done);
    assert!(task.finished_at.is_some());
    assert_eq!(task.project_id.as_deref(), Some("proj-b"));
    assert_eq!(task.result.as_deref(), Some("shipped"));
    // 省略字段不改，显式 null 清空
    assert_eq!(task.workspace.as_deref(), Some("wb-alpha"));

    update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            status: Some(Status::InProgress),
            project_id: Some(None),
            ..update(&id)
        },
    )
    .unwrap();
    let task = fetch_tasks(&conn, None, None, None, None).unwrap().remove(0);
    assert!(task.finished_at.is_none());
    assert!(task.result.is_none());
    assert!(task.project_id.is_none());

    delete_task(&conn, &id).unwrap();
    assert!(fetch_tasks(&conn, None, None, None, None).unwrap().is_empty());
}

#[test]
fn status_changes_follow_core_state_machine() {
    let conn = setup();
    insert_project(&conn, "proj-a", "Alpha");
    let id = create_task(
        &conn,
        &CreateTaskRequest {
            title: "Ship".into(),
            priority: None,
            tags: None,
            project_id: Some("proj-a".into()),
            workspace: None,
            session_id: None,
        },
    )
    .unwrap();

    // pending 不能直接跳到 done。
    let skipped = update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            status: Some(Status::Done),
            result: Some(Some("done".into())),
            ..update(&id)
        },
    )
    .unwrap_err();
    assert!(matches!(
        skipped,
        AppError::BadRequest {
            code: "E_INVALID_TRANSITION",
            ..
        }
    ));

    // 未填写结果不能完成任务。
    update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            status: Some(Status::InProgress),
            ..update(&id)
        },
    )
    .unwrap();
    let missing_result = update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            status: Some(Status::Done),
            ..update(&id)
        },
    )
    .unwrap_err();
    assert!(matches!(
        missing_result,
        AppError::BadRequest {
            code: "E_RESULT_REQUIRED",
            ..
        }
    ));

    // 阻塞必须写明原因。
    let missing_reason = update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            status: Some(Status::Blocked),
            ..update(&id)
        },
    )
    .unwrap_err();
    assert!(matches!(
        missing_reason,
        AppError::BadRequest {
            code: "E_BLOCKED_REASON_REQUIRED",
            ..
        }
    ));

    // 已取消的任务不能再改状态。
    update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            status: Some(Status::Cancelled),
            ..update(&id)
        },
    )
    .unwrap();
    let rejected = update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            status: Some(Status::Pending),
            ..update(&id)
        },
    )
    .unwrap_err();
    assert!(matches!(rejected, AppError::BadRequest { .. }));
}

#[test]
fn null_clears_optional_fields_and_omitted_fields_keep_values() {
    let conn = setup();
    let id = create_task(
        &conn,
        &CreateTaskRequest {
            title: "Probe".into(),
            priority: None,
            tags: None,
            project_id: None,
            workspace: None,
            session_id: None,
        },
    )
    .unwrap();

    // 显式 null 清空，字段缺省不动原值。
    let request: UpdateTaskRequest =
        serde_json::from_str(r#"{"result": "first", "blocked_reason": "waiting"}"#).unwrap();
    assert!(request.result.as_ref().unwrap().is_some());
    update_task(&conn, &id, &request).unwrap();
    let task = fetch_tasks(&conn, None, None, None, None).unwrap().remove(0);
    assert_eq!(task.result.as_deref(), Some("first"));
    assert_eq!(task.blocked_reason.as_deref(), Some("waiting"));

    let request: UpdateTaskRequest = serde_json::from_str(r#"{"result": null}"#).unwrap();
    assert_eq!(request.result, Some(None));
    update_task(&conn, &id, &request).unwrap();
    let task = fetch_tasks(&conn, None, None, None, None).unwrap().remove(0);
    assert!(task.result.is_none());
    assert_eq!(task.blocked_reason.as_deref(), Some("waiting"));

    let request: UpdateTaskRequest = serde_json::from_str("{}").unwrap();
    assert!(request.result.is_none());
    update_task(&conn, &id, &request).unwrap();
    let task = fetch_tasks(&conn, None, None, None, None).unwrap().remove(0);
    assert_eq!(task.blocked_reason.as_deref(), Some("waiting"));
}

#[test]
fn legacy_database_without_new_columns_still_works() {
    let conn = setup_legacy();
    insert_project(&conn, "proj-a", "Alpha");
    insert_task(&conn, "t1", "proj-a", "in_progress", "high");

    let tasks = fetch_tasks(&conn, None, None, None, None).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].status, Status::InProgress);
    assert!(tasks[0].artifacts.is_empty());
    assert!(tasks[0].updated_at.is_none());

    update_task(
        &conn,
        &tasks[0].id,
        &UpdateTaskRequest {
            title: Some("Renamed".into()),
            ..update("t1")
        },
    )
    .unwrap();
    let tasks = fetch_tasks(&conn, None, None, None, None).unwrap();
    assert_eq!(tasks[0].title, "Renamed");
    assert_eq!(tasks[0].status, Status::InProgress);

    let projects = fetch_projects(&conn, false).unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].task_count.in_progress, 1);
}

#[test]
fn missing_metadata_columns_are_added_on_startup() {
    let conn = setup_legacy();
    insert_project(&conn, "proj-a", "Alpha");
    insert_task(&conn, "t1", "proj-a", "pending", "medium");

    // 旧库没有 workspace / session_id，启动检查时补列。
    db::ensure_database(&conn).unwrap();
    let columns = Columns::load(&conn, "tasks", &db::TASK_FIELDS).unwrap();
    assert!(columns.has("workspace"));
    assert!(columns.has("session_id"));

    update_task(
        &conn,
        "t1",
        &UpdateTaskRequest {
            workspace: Some(Some("wb-beta".into())),
            session_id: Some(Some("sess-7".into())),
            ..update("t1")
        },
    )
    .unwrap();
    let task = fetch_tasks(&conn, None, None, None, None).unwrap().remove(0);
    assert_eq!(task.workspace.as_deref(), Some("wb-beta"));
    assert_eq!(task.session_id.as_deref(), Some("sess-7"));

    update_task(
        &conn,
        "t1",
        &UpdateTaskRequest {
            workspace: Some(None),
            session_id: Some(None),
            ..update("t1")
        },
    )
    .unwrap();
    let task = fetch_tasks(&conn, None, None, None, None).unwrap().remove(0);
    assert!(task.workspace.is_none());
    assert!(task.session_id.is_none());
}

#[test]
fn daily_counts_fill_missing_days_and_respect_project() {
    let conn = setup();
    insert_project(&conn, "proj-a", "Alpha");
    insert_project(&conn, "proj-b", "Beta");
    insert_task(&conn, "t1", "proj-a", "pending", "high");
    insert_task(&conn, "t2", "proj-a", "pending", "low");
    insert_task(&conn, "t3", "proj-b", "pending", "low");

    let days = daily_task_counts(&conn, None, 7).unwrap();
    assert_eq!(days.len(), 7);
    let today = Utc::now().format("%Y-%m-%d").to_string();
    assert_eq!(days.last().unwrap().date, today);
    assert_eq!(days.last().unwrap().count, 3);
    assert!(days[..6].iter().all(|day| day.count == 0));

    let project_days = daily_task_counts(&conn, Some("proj-a"), 3).unwrap();
    assert_eq!(project_days.len(), 3);
    assert_eq!(project_days.last().unwrap().count, 2);

    // 超出上限按 31 天处理
    assert_eq!(daily_task_counts(&conn, None, 90).unwrap().len(), 31);
}

#[test]
fn tasks_filter_by_creation_date() {
    let conn = setup();
    insert_project(&conn, "proj-a", "Alpha");
    insert_task(&conn, "today", "proj-a", "pending", "medium");
    insert_task(&conn, "older", "proj-a", "pending", "medium");
    conn.execute(
        "UPDATE tasks SET created_at = ?1 WHERE id = 'older'",
        [(Utc::now() - Duration::days(3)).to_rfc3339()],
    )
    .unwrap();

    let today = Utc::now().format("%Y-%m-%d").to_string();
    let filtered = fetch_tasks(&conn, None, None, None, Some(&today)).unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].id, "today");

    let older = (Utc::now() - Duration::days(3)).format("%Y-%m-%d").to_string();
    let filtered = fetch_tasks(&conn, None, None, None, Some(&older)).unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].id, "older");

    assert!(fetch_tasks(&conn, None, None, None, Some("nope")).is_err());
}

#[test]
fn invalid_input_and_missing_rows_are_reported() {
    let conn = setup();
    let invalid_project = create_project(
        &conn,
        &CreateProjectRequest {
            name: "   ".into(),
            description: None,
            path: None,
        },
    )
    .unwrap_err();
    assert!(matches!(invalid_project, AppError::BadRequest { .. }));

    insert_project(&conn, "proj-a", "Alpha");
    let unknown_project = create_task(
        &conn,
        &CreateTaskRequest {
            title: "Task".into(),
            priority: None,
            tags: None,
            project_id: Some("nope".into()),
            workspace: None,
            session_id: None,
        },
    )
    .unwrap_err();
    assert!(matches!(unknown_project, AppError::NotFound(_)));

    let invalid_priority: Result<CreateTaskRequest, _> =
        serde_json::from_str(r#"{"title": "Task", "priority": "urgent"}"#);
    assert!(invalid_priority.is_err());

    let missing = delete_task(&conn, "nope").unwrap_err();
    assert!(matches!(missing, AppError::NotFound(_)));

    let missing_project = delete_project(&conn, "nope").unwrap_err();
    assert!(matches!(missing_project, AppError::NotFound(_)));
}
