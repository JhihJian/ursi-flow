//! 工作区草稿与材料记录。落库字段即 HTTP 详情，不额外保存上传文件名以外的路径信息。
use super::super::{Error, workspace_sop};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use uuid::Uuid;

/// 材料名称与角色的长度上限。两者都只作为记录展示或单级路径段。
const NAME_LIMIT: usize = 255;

/// 创建工作包只接受类型和需求。执行时选择的 SOP 版本不属于草稿。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Draft {
    type_id: String,
    requirement: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Edit {
    requirement: String,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Role {
    id: String,
    label: String,
}

#[derive(Deserialize)]
struct Type {
    roles: Vec<Role>,
}

/// 上传文件名只用于展示，不允许任何可改变路径的字符。
pub(super) fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= NAME_LIMIT
        && name != "."
        && name != ".."
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
}

fn internal(what: &str) -> Error {
    Error::Internal(format!("无效的工作区记录：{what}"))
}

pub(super) fn workspace<'a>(db: &'a Value, id: &str) -> Result<&'a Value, Error> {
    db["workspaces"]
        .get(id)
        .ok_or_else(|| Error::NotFound(format!("工作区 {id} 不存在")))
}

pub(super) fn workspace_mut<'a>(db: &'a mut Value, id: &str) -> Result<&'a mut Value, Error> {
    db.get_mut("workspaces")
        .and_then(|workspaces| workspaces.get_mut(id))
        .ok_or_else(|| Error::NotFound(format!("工作区 {id} 不存在")))
}

pub(super) fn list(db: &Value) -> Result<Value, Error> {
    let workspaces = match db.get("workspaces") {
        None => None,
        Some(v) => Some(v.as_object().ok_or_else(|| internal("字典"))?),
    };
    Ok(Value::Array(
        workspaces
            .into_iter()
            .flat_map(Map::values)
            .cloned()
            .collect(),
    ))
}

fn requirement(text: &str) -> Result<(), Error> {
    if text.trim().is_empty() {
        return Err(Error::Invalid("需求不能为空".into()));
    }
    Ok(())
}

pub(super) fn create(db: &mut Value, req: Draft) -> Result<Value, Error> {
    requirement(&req.requirement)?;
    let ty = workspace_sop::workspace_type(&req.type_id)?;
    let ty: Type = serde_json::from_value(ty).map_err(|_| internal("工作包类型"))?;
    let mut seen = BTreeSet::new();
    for role in &ty.roles {
        if !plain_name(&role.id) || role.label.trim().is_empty() || !seen.insert(&role.id) {
            return Err(internal("材料角色"));
        }
    }
    let id = Uuid::new_v4().to_string();
    let mut doc = json!({"id":id,"typeId":req.type_id,"requirement":req.requirement,"ready":false,
        "frozen":false,"roles":ty.roles,"materials":[],"attempts":[]});
    sync_ready(&mut doc);
    db["workspaces"][&id] = doc.clone();
    Ok(doc)
}

fn editable(doc: &Value) -> Result<(), Error> {
    match doc["frozen"].as_bool() {
        Some(false) => Ok(()),
        Some(true) => Err(Error::Conflict("工作区已冻结，不能再修改".into())),
        None => Err(internal("冻结标记")),
    }
}

/// 就绪只看需求非空和材料角色齐全。它不代表执行尝试、回执或验收结论。
pub(super) fn readiness(doc: &Value) -> bool {
    let requirement = doc["requirement"]
        .as_str()
        .is_some_and(|text| !text.trim().is_empty());
    let (Some(roles), Some(materials)) = (doc["roles"].as_array(), doc["materials"].as_array())
    else {
        return false;
    };
    requirement
        && roles.iter().all(|role| {
            role["id"]
                .as_str()
                .is_some_and(|id| materials.iter().any(|m| m["role"].as_str() == Some(id)))
        })
}

fn sync_ready(doc: &mut Value) {
    let ready = readiness(doc);
    doc["ready"] = ready.into();
}

pub(super) fn edit(doc: &mut Value, req: Edit) -> Result<Value, Error> {
    editable(doc)?;
    requirement(&req.requirement)?;
    doc["requirement"] = req.requirement.into();
    sync_ready(doc);
    Ok(doc.clone())
}

/// 收存前的业务检查。冻结标记、角色归属和已有材料都与写入共用一次 Store 更新。
pub(super) fn material_slot(doc: &Value, role: &str) -> Result<(), Error> {
    editable(doc)?;
    let roles = doc["roles"]
        .as_array()
        .ok_or_else(|| internal("材料角色定义"))?;
    if !roles.iter().any(|r| r["id"] == role) {
        return Err(Error::Invalid(format!("未知材料角色：{role}")));
    }
    let materials = doc["materials"]
        .as_array()
        .ok_or_else(|| internal("材料记录"))?;
    if materials.iter().any(|m| m["role"] == role) {
        return Err(Error::Conflict(format!("材料角色已收存：{role}")));
    }
    Ok(())
}

pub(super) fn add_material(
    doc: &mut Value,
    role: &str,
    name: &str,
    size: u64,
) -> Result<Value, Error> {
    let materials = doc["materials"]
        .as_array_mut()
        .ok_or_else(|| internal("材料记录"))?;
    materials.push(json!({"role":role,"name":name,"size":size}));
    sync_ready(doc);
    Ok(doc.clone())
}
