//! 两级规划图：画布、任务卡、关系及各图的布局。

use super::Error;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Graph {
    canvases: Vec<Canvas>,
    task_cards: Vec<TaskCard>,
    relations: Vec<Relation>,
    layouts: Layouts,
}

#[derive(Deserialize, Serialize)]
struct Canvas {
    id: String,
    name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskCard {
    id: String,
    canvas_id: String,
    name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Relation {
    id: String,
    canvas_id: Option<String>,
    from: String,
    to: String,
}

#[derive(Default, Deserialize, Serialize)]
struct Layouts {
    map: Layout,
    canvases: BTreeMap<String, Layout>,
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Layout {
    revision: u64,
    positions: Positions,
}

pub(super) type Positions = BTreeMap<String, Point>;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Point {
    x: f64,
    y: f64,
}

pub(super) fn validate_name(name: &str) -> Result<String, Error> {
    let name = name.trim();
    if name.is_empty() || name.chars().any(char::is_control) {
        return Err(Error::Invalid("名称不能为空或包含控制字符".into()));
    }
    Ok(name.into())
}

fn missing_canvas() -> Error {
    Error::NotFound("画布不存在".into())
}

fn missing_card() -> Error {
    Error::NotFound("任务卡不存在".into())
}

fn missing_relation() -> Error {
    Error::NotFound("规划关系不存在".into())
}

fn next_revision(revision: u64) -> Result<u64, Error> {
    revision
        .checked_add(1)
        .ok_or_else(|| Error::Internal("布局修订号已达上限".into()))
}

impl Layout {
    fn remove_position(&mut self, id: &str) -> Result<(), Error> {
        if self.positions.contains_key(id) {
            self.revision = next_revision(self.revision)?;
            self.positions.remove(id);
        }
        Ok(())
    }
}

impl Graph {
    pub(super) fn new() -> Self {
        let mut graph = Self {
            canvases: Vec::new(),
            task_cards: Vec::new(),
            relations: Vec::new(),
            layouts: Layouts::default(),
        };
        graph.add_canvas("默认画布".into());
        graph
    }

    fn add_canvas(&mut self, name: String) -> String {
        let id = Uuid::new_v4().to_string();
        self.canvases.push(Canvas {
            id: id.clone(),
            name,
        });
        self.layouts.canvases.insert(id.clone(), Layout::default());
        id
    }

    pub(super) fn create_canvas(&mut self, name: &str) -> Result<String, Error> {
        Ok(self.add_canvas(validate_name(name)?))
    }

    pub(super) fn rename_canvas(&mut self, id: &str, name: &str) -> Result<(), Error> {
        let canvas = self
            .canvases
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(missing_canvas)?;
        canvas.name = validate_name(name)?;
        Ok(())
    }

    pub(super) fn delete_canvas(&mut self, id: &str) -> Result<(), Error> {
        self.check_scope(Some(id))?;
        if self.canvases.len() == 1 {
            return Err(Error::Conflict("项目至少需要一张画布".into()));
        }
        self.layouts.map.remove_position(id)?;
        self.layouts.canvases.remove(id);
        self.relations.retain(|r| match r.canvas_id.as_deref() {
            None => r.from != id && r.to != id,
            Some(canvas) => canvas != id,
        });
        self.task_cards.retain(|card| card.canvas_id != id);
        self.canvases.retain(|canvas| canvas.id != id);
        Ok(())
    }

    pub(super) fn create_task_card(
        &mut self,
        canvas_id: String,
        name: &str,
    ) -> Result<String, Error> {
        self.check_scope(Some(&canvas_id))?;
        let id = Uuid::new_v4().to_string();
        self.task_cards.push(TaskCard {
            id: id.clone(),
            canvas_id,
            name: validate_name(name)?,
        });
        Ok(id)
    }

    pub(super) fn rename_task_card(&mut self, id: &str, name: &str) -> Result<(), Error> {
        let card = self
            .task_cards
            .iter_mut()
            .find(|card| card.id == id)
            .ok_or_else(missing_card)?;
        card.name = validate_name(name)?;
        Ok(())
    }

    pub(super) fn delete_task_card(&mut self, id: &str) -> Result<(), Error> {
        let canvas_id = self.canvas_for_card(id)?.to_owned();
        self.canvas_layout_mut(&canvas_id)?.remove_position(id)?;
        self.relations
            .retain(|r| r.canvas_id.as_deref() != Some(&canvas_id) || (r.from != id && r.to != id));
        self.task_cards.retain(|card| card.id != id);
        Ok(())
    }

    pub(super) fn canvas_for_card(&self, id: &str) -> Result<&str, Error> {
        self.task_cards
            .iter()
            .find(|card| card.id == id)
            .map(|card| card.canvas_id.as_str())
            .ok_or_else(missing_card)
    }

    pub(super) fn cards_on_canvas<'a>(&'a self, id: &'a str) -> impl Iterator<Item = &'a str> {
        self.task_cards
            .iter()
            .filter(move |card| card.canvas_id == id)
            .map(|card| card.id.as_str())
    }

    fn check_scope(&self, canvas_id: Option<&str>) -> Result<(), Error> {
        if canvas_id.is_some_and(|id| !self.canvases.iter().any(|canvas| canvas.id == id)) {
            return Err(missing_canvas());
        }
        Ok(())
    }

    fn contains_node(&self, canvas_id: Option<&str>, id: &str) -> bool {
        match canvas_id {
            None => self.canvases.iter().any(|canvas| canvas.id == id),
            Some(canvas) => self
                .task_cards
                .iter()
                .any(|card| card.canvas_id == canvas && card.id == id),
        }
    }

    fn validate_relation(
        &self,
        canvas_id: Option<&str>,
        from: &str,
        to: &str,
        skip: Option<&str>,
    ) -> Result<(), Error> {
        self.check_scope(canvas_id)?;
        if !self.contains_node(canvas_id, from) || !self.contains_node(canvas_id, to) {
            return Err(Error::Invalid("关系端点必须属于同一张图".into()));
        }
        if from == to {
            return Err(Error::Invalid("关系端点不能相同".into()));
        }
        let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
        for edge in self
            .relations
            .iter()
            .filter(|r| r.canvas_id.as_deref() == canvas_id && Some(r.id.as_str()) != skip)
        {
            if edge.from == from && edge.to == to {
                return Err(Error::Invalid("规划关系已存在".into()));
            }
            outgoing.entry(&edge.from).or_default().push(&edge.to);
        }
        // 加入 from → to 前，检查 to 是否已能到达 from。
        let mut pending = vec![to];
        let mut visited = HashSet::new();
        while let Some(node) = pending.pop() {
            if node == from {
                return Err(Error::Invalid("规划关系不能成环".into()));
            }
            if visited.insert(node)
                && let Some(next) = outgoing.get(node)
            {
                pending.extend(next.iter().copied());
            }
        }
        Ok(())
    }

    pub(super) fn create_relation(
        &mut self,
        canvas_id: Option<String>,
        from: String,
        to: String,
    ) -> Result<String, Error> {
        self.validate_relation(canvas_id.as_deref(), &from, &to, None)?;
        let id = Uuid::new_v4().to_string();
        self.relations.push(Relation {
            id: id.clone(),
            canvas_id,
            from,
            to,
        });
        Ok(id)
    }

    pub(super) fn replace_relation(
        &mut self,
        id: &str,
        from: String,
        to: String,
    ) -> Result<(), Error> {
        let index = self
            .relations
            .iter()
            .position(|r| r.id == id)
            .ok_or_else(missing_relation)?;
        self.validate_relation(
            self.relations[index].canvas_id.as_deref(),
            &from,
            &to,
            Some(id),
        )?;
        let edge = &mut self.relations[index];
        edge.from = from;
        edge.to = to;
        Ok(())
    }

    pub(super) fn delete_relation(&mut self, id: &str) -> Result<(), Error> {
        let index = self
            .relations
            .iter()
            .position(|r| r.id == id)
            .ok_or_else(missing_relation)?;
        self.relations.remove(index);
        Ok(())
    }

    fn canvas_layout_mut(&mut self, id: &str) -> Result<&mut Layout, Error> {
        self.layouts
            .canvases
            .get_mut(id)
            .ok_or_else(|| Error::Internal("画布布局记录缺失".into()))
    }

    pub(super) fn save_layout(
        &mut self,
        canvas_id: Option<&str>,
        revision: u64,
        positions: Positions,
    ) -> Result<&Layout, Error> {
        self.check_scope(canvas_id)?;
        let current = match canvas_id {
            None => &self.layouts.map,
            Some(id) => self
                .layouts
                .canvases
                .get(id)
                .ok_or_else(|| Error::Internal("画布布局记录缺失".into()))?,
        };
        if current.revision != revision {
            return Err(Error::Conflict("布局已被修改，请刷新".into()));
        }
        if positions.iter().any(|(id, p)| {
            !p.x.is_finite() || !p.y.is_finite() || !self.contains_node(canvas_id, id)
        }) {
            return Err(Error::Invalid("节点须属于当前图且坐标须为有限数值".into()));
        }
        let layout = match canvas_id {
            None => &mut self.layouts.map,
            Some(id) => self.canvas_layout_mut(id)?,
        };
        *layout = Layout {
            revision: next_revision(layout.revision)?,
            positions,
        };
        Ok(layout)
    }
}
