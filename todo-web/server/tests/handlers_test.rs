use chrono::{Duration, Utc};
use rusqlite::Connection;
use todo_web_server::handlers::{
    calculate_stats, create_project, create_task, delete_project, delete_task, fetch_projects,
    fetch_tasks, update_project, update_task, AppError,
};
use todo_web_server::models::{
    CreateProjectRequest, CreateTaskRequest, UpdateProjectRequest, UpdateTaskRequest,
};

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
            priority TEXT NOT NULL DEFAULT 'medium',
            status TEXT NOT NULL DEFAULT 'pending',
            tags TEXT DEFAULT '[]',
            parent_id TEXT,
            project_id TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            blocked_reason TEXT,
            result TEXT,
            updated_at TEXT
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

#[test]
fn empty_database_returns_empty_lists_and_zero_stats() {
    let conn = setup();
    assert!(fetch_projects(&conn, false).unwrap().is_empty());
    assert!(fetch_tasks(&conn, None, None, None).unwrap().is_empty());
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
        .find(|project| project.id == "proj-a")
        .unwrap();
    assert_eq!(alpha.task_count.pending, 1);
    assert_eq!(alpha.task_count.in_progress, 1);
    assert_eq!(alpha.task_count.blocked, 1);
    assert_eq!(alpha.task_count.done, 1);
    assert!(
        (89..=90).contains(&alpha.total_time_minutes),
        "{}",
        alpha.total_time_minutes
    );

    let active = fetch_projects(&conn, true).unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, "proj-a");
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

    let project_tasks = fetch_tasks(&conn, Some("proj-a"), None, None).unwrap();
    assert_eq!(project_tasks.len(), 2);

    let done_tasks = fetch_tasks(&conn, None, Some("done"), None).unwrap();
    assert_eq!(done_tasks.len(), 2);

    let daily = fetch_tasks(&conn, Some("proj-a"), None, Some("daily")).unwrap();
    assert_eq!(daily.len(), 2);
    let ids: Vec<_> = daily.iter().map(|task| task.id.as_str()).collect();
    assert!(ids.contains(&"pending-a"));
    assert!(ids.contains(&"done-a"));

    let daily_b = fetch_tasks(&conn, Some("proj-b"), None, Some("daily")).unwrap();
    assert!(daily_b.is_empty());
}

#[test]
fn daily_stats_count_done_tasks_and_minutes() {
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
    let project = fetch_projects(&conn, false).unwrap().remove(0);
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
    let project = fetch_projects(&conn, false).unwrap().remove(0);
    assert!(project.description.is_none());
    assert!(project.path.is_none());

    insert_task(&conn, "t1", &id, "pending", "high");
    delete_project(&conn, &id).unwrap();
    assert!(fetch_projects(&conn, false).unwrap().is_empty());
    let task = fetch_tasks(&conn, None, None, None).unwrap().remove(0);
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
            priority: Some("high".into()),
            tags: Some(vec!["docs".into()]),
            project_id: Some("proj-a".into()),
        },
    )
    .unwrap();

    update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            title: None,
            priority: None,
            status: Some("in_progress".into()),
            tags: None,
            project_id: None,
            blocked_reason: None,
            result: None,
        },
    )
    .unwrap();
    let task = fetch_tasks(&conn, None, None, None).unwrap().remove(0);
    assert!(task.started_at.is_some());
    assert!(task.finished_at.is_none());

    update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            title: Some("Write docs".into()),
            priority: None,
            status: Some("done".into()),
            tags: None,
            project_id: Some(Some("proj-b".into())),
            blocked_reason: None,
            result: Some(Some("shipped".into())),
        },
    )
    .unwrap();
    let task = fetch_tasks(&conn, None, None, None).unwrap().remove(0);
    assert_eq!(task.title, "Write docs");
    assert_eq!(task.status, "done");
    assert!(task.finished_at.is_some());
    assert_eq!(task.project_id.as_deref(), Some("proj-b"));
    assert_eq!(task.result.as_deref(), Some("shipped"));

    update_task(
        &conn,
        &id,
        &UpdateTaskRequest {
            title: None,
            priority: None,
            status: Some("in_progress".into()),
            tags: None,
            project_id: Some(None),
            blocked_reason: None,
            result: None,
        },
    )
    .unwrap();
    let task = fetch_tasks(&conn, None, None, None).unwrap().remove(0);
    assert!(task.finished_at.is_none());
    assert!(task.project_id.is_none());

    delete_task(&conn, &id).unwrap();
    assert!(fetch_tasks(&conn, None, None, None).unwrap().is_empty());
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
    assert!(matches!(invalid_project, AppError::BadRequest(_)));

    insert_project(&conn, "proj-a", "Alpha");
    let invalid_priority = create_task(
        &conn,
        &CreateTaskRequest {
            title: "Task".into(),
            priority: Some("urgent".into()),
            tags: None,
            project_id: Some("proj-a".into()),
        },
    )
    .unwrap_err();
    assert!(matches!(invalid_priority, AppError::BadRequest(_)));

    let missing = delete_task(&conn, "nope").unwrap_err();
    assert!(matches!(missing, AppError::NotFound(_)));
}
