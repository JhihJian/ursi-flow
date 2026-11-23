//! 项目、事项归属和工作区快照共用工作清单的 Store 事务。

use super::{Category, Definition, Error, Store, find, insert_item, present};
use crate::work::canvas::{Graph, Positions, validate_name};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post, put},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

#[cfg(test)]
mod tests;

const TABLE: &str = "workProjects";
type Reply = Result<Json<Value>, Error>;

pub(super) fn routes() -> Router<Store> {
    Router::new()
        .route("/v2/work-projects", get(list).post(create))
        .route("/v2/work-projects/{id}", put(rename).delete(delete))
        .route("/v2/work-projects/{id}/workspace", get(workspace))
        .route("/v2/work-projects/{id}/commands", post(command))
        .route("/v2/work-projects/{id}/layout", put(layout))
        .route("/v2/work-items/{id}/placement", get(placement))
}

#[derive(Deserialize, Serialize)]
struct Project {
    id: String,
    name: String,
    revision: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Placement {
    task_card_id: String,
    rank: usize,
}

#[derive(Deserialize, Serialize)]
struct Record {
    project: Project,
    graph: Graph,
    placements: BTreeMap<String, Placement>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlacedItem<'a> {
    item: &'a Value,
    task_card_id: &'a str,
    rank: usize,
}

#[derive(Serialize)]
struct Workspace<'a> {
    project: &'a Project,
    #[serde(flatten)]
    graph: &'a Graph,
    items: Vec<PlacedItem<'a>>,
}

fn corrupt() -> Error {
    Error::Internal("项目规划记录损坏".into())
}

fn missing() -> Error {
    Error::NotFound("项目不存在".into())
}

fn records(db: &Value) -> Result<Option<&Map<String, Value>>, Error> {
    db.get(TABLE)
        .map(|value| value.as_object().ok_or_else(corrupt))
        .transpose()
}

fn load(db: &Value, id: &str) -> Result<Record, Error> {
    let row = records(db)?
        .and_then(|table| table.get(id))
        .ok_or_else(missing)?;
    Record::deserialize(row).map_err(|_| corrupt())
}

fn save(db: &mut Value, entry: &Record) -> Result<(), Error> {
    let row = serde_json::to_value(entry).map_err(|_| corrupt())?;
    db.as_object_mut()
        .ok_or_else(corrupt)?
        .entry(TABLE)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(corrupt)?
        .insert(entry.project.id.clone(), row);
    Ok(())
}

fn project_with_item<'a>(db: &'a Value, id: &str) -> Result<Option<&'a str>, Error> {
    Ok(records(db)?
        .into_iter()
        .flatten()
        .find_map(|(project_id, row)| row["placements"].get(id).map(|_| project_id.as_str())))
}

impl Project {
    fn check_revision(&self, expected: u64) -> Result<(), Error> {
        if expected != self.revision {
            return Err(Error::Conflict("项目结构已被修改，请刷新".into()));
        }
        Ok(())
    }

    fn bump(&mut self) -> Result<(), Error> {
        self.revision = self.revision.checked_add(1).ok_or_else(corrupt)?;
        Ok(())
    }
}

impl Record {
    fn append_item(&mut self, id: String, task_card_id: String) {
        let rank = self
            .placements
            .values()
            .filter(|p| p.task_card_id == task_card_id)
            .count();
        self.placements.insert(id, Placement { task_card_id, rank });
    }

    fn remove_item(&mut self, id: &str) {
        if let Some(old) = self.placements.remove(id) {
            for p in self
                .placements
                .values_mut()
                .filter(|p| p.task_card_id == old.task_card_id && p.rank > old.rank)
            {
                p.rank -= 1;
            }
        }
    }

    fn reorder(&mut self, task_card_id: &str, item_ids: Vec<String>) -> Result<(), Error> {
        self.graph.canvas_for_card(task_card_id)?;
        let members: HashSet<&str> = self
            .placements
            .iter()
            .filter(|(_, p)| p.task_card_id == task_card_id)
            .map(|(id, _)| id.as_str())
            .collect();
        let requested: HashSet<&str> = item_ids.iter().map(String::as_str).collect();
        if requested.len() != item_ids.len() || requested != members {
            return Err(Error::Invalid(
                "排序须提供该卡的全部事项，每项仅出现一次".into(),
            ));
        }
        for (rank, id) in item_ids.iter().enumerate() {
            self.placements.get_mut(id).ok_or_else(corrupt)?.rank = rank;
        }
        Ok(())
    }

    fn has_items(&self, card: &str) -> bool {
        self.placements.values().any(|p| p.task_card_id == card)
    }
}

pub(super) fn detach_item(db: &mut Value, id: &str) -> Result<(), Error> {
    if let Some(project_id) = project_with_item(db, id)? {
        let mut entry = load(db, project_id)?;
        entry.remove_item(id);
        entry.project.bump()?;
        save(db, &entry)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rename {
    name: String,
    revision: u64,
}

async fn list(State(store): State<Store>) -> Reply {
    store.read(|db| {
        let projects: Vec<_> = records(db)?
            .into_iter()
            .flat_map(Map::values)
            .map(|row| row.get("project").ok_or_else(corrupt))
            .collect::<Result<_, _>>()?;
        Ok(Json(json!(projects)))
    })
}

async fn create(State(store): State<Store>, Json(body): Json<Create>) -> Reply {
    let entry = Record {
        project: Project {
            id: Uuid::new_v4().to_string(),
            name: validate_name(&body.name)?,
            revision: 1,
        },
        graph: Graph::new(),
        placements: BTreeMap::new(),
    };
    store.update(|db| {
        save(db, &entry)?;
        Ok(Json(json!(entry.project)))
    })
}

async fn rename(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(body): Json<Rename>,
) -> Reply {
    store.update(|db| {
        let mut entry = load(db, &id)?;
        entry.project.check_revision(body.revision)?;
        entry.project.name = validate_name(&body.name)?;
        entry.project.bump()?;
        save(db, &entry)?;
        Ok(Json(json!(entry.project)))
    })
}

async fn delete(State(store): State<Store>, Path(id): Path<String>) -> Result<StatusCode, Error> {
    store.update(|db| {
        let entry = load(db, &id)?;
        if !entry.placements.is_empty() {
            return Err(Error::Conflict("请先移出项目中的工作项".into()));
        }
        db[TABLE].as_object_mut().ok_or_else(corrupt)?.remove(&id);
        Ok(StatusCode::NO_CONTENT)
    })
}

async fn workspace(State(store): State<Store>, Path(id): Path<String>) -> Reply {
    store.read(|db| {
        let entry = load(db, &id)?;
        let mut items = entry
            .placements
            .iter()
            .map(|(id, p)| {
                Ok(PlacedItem {
                    item: find(db, id)?,
                    task_card_id: &p.task_card_id,
                    rank: p.rank,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        items.sort_unstable_by(|a, b| (a.task_card_id, a.rank).cmp(&(b.task_card_id, b.rank)));
        Ok(Json(json!(Workspace {
            project: &entry.project,
            graph: &entry.graph,
            items
        })))
    })
}

async fn placement(State(store): State<Store>, Path(id): Path<String>) -> Reply {
    store.read(|db| {
        find(db, &id)?;
        let Some(project_id) = project_with_item(db, &id)? else {
            return Ok(Json(Value::Null));
        };
        let entry = load(db, project_id)?;
        let card = &entry.placements.get(&id).ok_or_else(corrupt)?.task_card_id;
        let canvas = entry.graph.canvas_for_card(card)?;
        Ok(Json(
            json!({"projectId": project_id, "canvasId": canvas, "taskCardId": card}),
        ))
    })
}

#[derive(Deserialize)]
struct CommandRequest {
    revision: u64,
    #[serde(flatten)]
    command: Command,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    CreateCanvas {
        name: String,
    },
    RenameCanvas {
        canvas_id: String,
        name: String,
    },
    DeleteCanvas {
        canvas_id: String,
    },
    CreateTaskCard {
        canvas_id: String,
        name: String,
    },
    RenameTaskCard {
        task_card_id: String,
        name: String,
    },
    DeleteTaskCard {
        task_card_id: String,
    },
    CreateItem {
        task_card_id: String,
        title: String,
        #[serde(default)]
        description: String,
        #[serde(default, deserialize_with = "present")]
        category: Option<Category>,
    },
    PlaceItem {
        work_item_id: String,
        #[serde(deserialize_with = "Option::<String>::deserialize")]
        task_card_id: Option<String>,
    },
    ReorderItems {
        task_card_id: String,
        item_ids: Vec<String>,
    },
    CreateRelation {
        #[serde(deserialize_with = "Option::<String>::deserialize")]
        canvas_id: Option<String>,
        from: String,
        to: String,
    },
    ReplaceRelation {
        relation_id: String,
        from: String,
        to: String,
    },
    DeleteRelation {
        relation_id: String,
    },
}

impl Command {
    fn apply(self, db: &mut Value, entry: &mut Record) -> Result<Option<String>, Error> {
        match self {
            Self::CreateCanvas { name } => return Ok(Some(entry.graph.create_canvas(&name)?)),
            Self::RenameCanvas { canvas_id, name } => {
                entry.graph.rename_canvas(&canvas_id, &name)?
            }
            Self::DeleteCanvas { canvas_id } => {
                if entry
                    .graph
                    .cards_on_canvas(&canvas_id)
                    .any(|id| entry.has_items(id))
                {
                    return Err(Error::Conflict("请先移走画布中的工作项".into()));
                }
                entry.graph.delete_canvas(&canvas_id)?;
            }
            Self::CreateTaskCard { canvas_id, name } => {
                return Ok(Some(entry.graph.create_task_card(canvas_id, &name)?));
            }
            Self::RenameTaskCard { task_card_id, name } => {
                entry.graph.rename_task_card(&task_card_id, &name)?
            }
            Self::DeleteTaskCard { task_card_id } => {
                if entry.has_items(&task_card_id) {
                    return Err(Error::Conflict("请先移走任务卡中的工作项".into()));
                }
                entry.graph.delete_task_card(&task_card_id)?;
            }
            Self::CreateItem {
                task_card_id,
                title,
                description,
                category,
            } => {
                entry.graph.canvas_for_card(&task_card_id)?;
                let item = insert_item(
                    db,
                    Definition {
                        title,
                        description,
                        category,
                        status: None,
                        revision: None,
                    },
                )?;
                let id = item["id"].as_str().ok_or_else(corrupt)?.to_owned();
                entry.append_item(id.clone(), task_card_id);
                return Ok(Some(id));
            }
            Self::PlaceItem {
                work_item_id,
                task_card_id,
            } => {
                find(db, &work_item_id)?;
                if project_with_item(db, &work_item_id)?
                    .is_some_and(|owner| owner != entry.project.id)
                {
                    return Err(Error::Conflict("工作项属于其他项目，请先移出".into()));
                }
                if let Some(card) = &task_card_id {
                    entry.graph.canvas_for_card(card)?;
                }
                entry.remove_item(&work_item_id);
                if let Some(card) = task_card_id {
                    entry.append_item(work_item_id, card);
                }
            }
            Self::ReorderItems {
                task_card_id,
                item_ids,
            } => entry.reorder(&task_card_id, item_ids)?,
            Self::CreateRelation {
                canvas_id,
                from,
                to,
            } => return Ok(Some(entry.graph.create_relation(canvas_id, from, to)?)),
            Self::ReplaceRelation {
                relation_id,
                from,
                to,
            } => entry.graph.replace_relation(&relation_id, from, to)?,
            Self::DeleteRelation { relation_id } => entry.graph.delete_relation(&relation_id)?,
        }
        Ok(None)
    }
}

async fn command(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(body): Json<CommandRequest>,
) -> Reply {
    store.update(|db| {
        let mut entry = load(db, &id)?;
        entry.project.check_revision(body.revision)?;
        let id = body.command.apply(db, &mut entry)?;
        entry.project.bump()?;
        save(db, &entry)?;
        Ok(Json(id.map_or_else(|| json!({}), |id| json!({"id":id}))))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayoutRequest {
    #[serde(deserialize_with = "Option::<String>::deserialize")]
    canvas_id: Option<String>,
    revision: u64,
    positions: Positions,
}

async fn layout(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(body): Json<LayoutRequest>,
) -> Reply {
    store.update(|db| {
        let mut entry = load(db, &id)?;
        let new =
            entry
                .graph
                .save_layout(body.canvas_id.as_deref(), body.revision, body.positions)?;
        let reply = json!(new);
        save(db, &entry)?;
        Ok(Json(reply))
    })
}
