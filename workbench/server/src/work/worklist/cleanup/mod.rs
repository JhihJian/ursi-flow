//! Workbench 启动时对自有数据的一次性清理，早于任何请求服务。
use crate::work::{Error, Store};
use serde_json::Value;

pub(super) fn recover(store: &Store) -> Result<(), Error> {
    store.update(|db| {
        split_categories(db)?;
        drop_recipe_fields(db);
        drop_generations(db);
        Ok(())
    })
}

// 旧版本曾用 category 表达"一次性/持续"与状态的组合，升级为独立维度。
fn split_categories(db: &mut Value) -> Result<(), Error> {
    let Some(rows) = db.get_mut("workListItems").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    for (id, row) in rows {
        if row.get("status").is_some() {
            continue;
        }
        let (category, status) = match row["category"].as_str() {
            Some("continuous") => ("continuous", "pending"),
            Some(status @ ("pending" | "active" | "completed")) => ("one_time", status),
            _ => return Err(Error::Internal(format!("工作项 {id} 的旧类别无效"))),
        };
        row["status"] = Value::from(status);
        row["category"] = Value::from(category);
    }
    Ok(())
}

// 事项不再承载生成配方；历史字段直接剥离。
fn drop_recipe_fields(db: &mut Value) {
    let Some(rows) = db.get_mut("workListItems").and_then(Value::as_object_mut) else {
        return;
    };
    for row in rows.values_mut() {
        let Some(fields) = row.as_object_mut() else {
            continue;
        };
        fields.remove("recipe");
        fields.remove("generator");
    }
}

// 内嵌配方生成通道已删除，其请求索引表一并清理。
fn drop_generations(db: &mut Value) {
    if let Some(fields) = db.as_object_mut() {
        fields.remove("workListGenerations");
    }
}

#[cfg(test)]
mod tests;
