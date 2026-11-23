//! 工作规划：事项、项目结构与事项归属共享 Workbench 存储事务。
mod canvas;
mod items;
mod projects;

use super::{Error, Store, patches};
use axum::Router;
use serde_json::Value;

pub(super) use items::{find as find_item, recover};

pub(super) fn routes(store: Store) -> Router {
    items::routes().merge(projects::routes()).with_state(store)
}

fn remove_item(db: &mut Value, id: &str) -> Result<(), Error> {
    items::remove_row(db, id)?;
    projects::detach_item(db, id)?;
    patches::detach_item(db, id)
}
