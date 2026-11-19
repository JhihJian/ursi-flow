//! 内置 Echo SOP 执行器。每次执行解析本次 SOP 版本，校验需求与全部材料角色，在同一次
//! 更新中冻结工作区并把完整 SOP 定义随尝试记录；回执只依据材料文件的实际二进制内容生成。
#[cfg(test)]
mod tests;

use super::{Error, Store, workspace_sop};
use axum::{
    Router,
    body::Body,
    extract::{Json, Path, Query, State},
    http::{HeaderValue, header},
    response::Response,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read},
    os::unix::fs::OpenOptionsExt,
    path::Path as FsPath,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const ECHO_EXECUTOR: &str = "echo";
const FILES_DIR: &str = "workspace-files";
const RECEIPTS: &str = "receipts";
const DIGEST: &str = "fnv1a64";
const CHUNK: usize = 64 * 1024;

type Reply = Result<axum::Json<Value>, Error>;

pub fn routes(store: Store) -> Router {
    Router::new()
        .route("/v2/workspaces/{id}/attempts", post(execute))
        .route(
            "/v2/workspaces/{id}/attempts/{attempt}/receipt",
            get(receipt),
        )
        .with_state(store)
}

async fn execute(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(request): Json<Request>,
) -> Reply {
    tokio::task::spawn_blocking(move || store.update(|db| run(db, store.dir(), &id, request)))
        .await
        .map_err(|_| Error::Internal("SOP 执行任务中断".into()))?
        .map(axum::Json)
}

/// 每次执行可以显式指定 SOP 版本；省略时使用工作包类型的推荐默认版本。
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Request {
    #[serde(default)]
    sop: Option<workspace_sop::Reference>,
}

#[derive(Deserialize)]
struct Filter {
    download: Option<String>,
}

impl Filter {
    fn download(&self) -> bool {
        matches!(self.download.as_deref(), Some("true" | "1" | "yes"))
    }
}

async fn receipt(
    State(store): State<Store>,
    Path((id, attempt)): Path<(String, String)>,
    Query(filter): Query<Filter>,
) -> Result<Response, Error> {
    let text = store.read(|db| receipt_text(db, &id, &attempt))?;
    let mut response = Response::new(Body::from(text));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if filter.download() {
        headers.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment; filename=\"receipt.md\""),
        );
    }
    Ok(response)
}

fn corrupt(what: &str) -> Error {
    Error::Internal(format!("工作区数据损坏：{what}"))
}

fn workspace<'a>(db: &'a Value, id: &str) -> Result<&'a Value, Error> {
    db.get("workspaces")
        .and_then(|w| w.get(id))
        .ok_or_else(|| Error::NotFound("工作区不存在".into()))
}

fn workspace_mut<'a>(db: &'a mut Value, id: &str) -> Result<&'a mut Value, Error> {
    db.get_mut("workspaces")
        .and_then(|w| w.get_mut(id))
        .ok_or_else(|| Error::NotFound("工作区不存在".into()))
}

fn receipts_mut(db: &mut Value) -> Result<&mut Map<String, Value>, Error> {
    if db.get("receipts").is_none() {
        db["receipts"] = json!({});
    }
    db["receipts"]
        .as_object_mut()
        .ok_or_else(|| corrupt("receipts"))
}

/// 材料目录只用单级路径段：服务端生成的标识和角色名，不接受任意文件名或分隔符。
fn segment(s: &str) -> Result<(), ()> {
    let safe = !s.is_empty()
        && s.len() <= 255
        && s != "."
        && s != ".."
        && !s.chars().any(|c| c.is_control() || matches!(c, '/' | '\\'));
    if safe { Ok(()) } else { Err(()) }
}

/// 上传文件的原名只用于回执展示，不能进入路径或 Markdown 表格结构。
fn display(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect::<String>()
        .replace('|', "\\|");
    if cleaned.trim().is_empty() {
        "未命名材料".into()
    } else {
        cleaned
    }
}

struct Material {
    role: String,
    label: String,
    name: String,
    blob: String,
}

struct Plan {
    title: String,
    materials: Vec<Material>,
}

fn plan(workspace: &Value, sop: &Value) -> Result<Plan, Error> {
    let requirement = workspace["requirement"]
        .as_str()
        .ok_or_else(|| corrupt("requirement"))?;
    if requirement.trim().is_empty() {
        return Err(Error::Invalid("需求不能为空，无法开始执行".into()));
    }
    // 本次执行选定的 SOP 修订在解析后立即校验，并随尝试一起冻结。
    if sop["id"].as_str().is_none_or(str::is_empty) {
        return Err(corrupt("sop.id"));
    }
    if sop["executor"].as_str() != Some(ECHO_EXECUTOR) {
        return Err(Error::Internal("SOP 与 Echo 执行器不匹配".into()));
    }
    if sop["revision"]
        .as_u64()
        .is_none_or(|revision| revision == 0)
    {
        return Err(corrupt("sop"));
    }
    let title = sop["config"]["title"]
        .as_str()
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| corrupt("sop.config.title"))?
        .to_owned();
    let roles = workspace["roles"]
        .as_array()
        .filter(|r| !r.is_empty())
        .ok_or_else(|| corrupt("roles"))?;
    let mut labels = BTreeMap::new();
    for role in roles {
        let id = role["id"]
            .as_str()
            .filter(|s| segment(s).is_ok())
            .ok_or_else(|| corrupt("role id"))?;
        let label = role["label"]
            .as_str()
            .ok_or_else(|| corrupt("role label"))?;
        if labels.insert(id.to_owned(), label.to_owned()).is_some() {
            return Err(corrupt("duplicate role"));
        }
    }
    let received = workspace["materials"]
        .as_array()
        .ok_or_else(|| corrupt("materials"))?;
    let mut materials: BTreeMap<&str, Material> = BTreeMap::new();
    for material in received {
        let role = material["role"]
            .as_str()
            .ok_or_else(|| corrupt("material role"))?;
        let label = labels
            .get(role)
            .ok_or_else(|| corrupt("material role"))?
            .clone();
        let name = display(material["name"].as_str().unwrap_or(role));
        // 上传模块可能给出服务端为材料分配的 blob 标识；缺失时按工作区 UUID 定位。
        let blob = match material.get("blob") {
            Some(Value::String(blob)) => blob.clone(),
            Some(_) => return Err(corrupt("material blob")),
            None => workspace["id"]
                .as_str()
                .ok_or_else(|| corrupt("workspace id"))?
                .to_owned(),
        };
        if segment(&blob).is_err() {
            return Err(corrupt("material blob"));
        }
        let entry = Material {
            role: role.to_owned(),
            label,
            name,
            blob,
        };
        if materials.insert(role, entry).is_some() {
            return Err(corrupt("duplicate material"));
        }
    }
    let materials = labels
        .iter()
        .map(|(id, label)| {
            materials
                .remove(id.as_str())
                .ok_or_else(|| Error::Invalid(format!("尚未收到「{label}」材料")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Plan { title, materials })
}

fn safe_dir(path: &FsPath) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "材料目录不是普通目录",
        ));
    }
    Ok(())
}

fn open_material(path: &FsPath) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    if !file.metadata()?.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "材料必须是普通文件",
        ));
    }
    Ok(file)
}

/// 以流式方式重新读取材料文件，返回实际字节数和 FNV-1a 64 位内容摘要。
fn digest(path: &FsPath) -> io::Result<(u64, u64)> {
    let mut reader = BufReader::with_capacity(CHUNK, open_material(path)?);
    let mut buffer = vec![0u8; CHUNK];
    let mut size = 0u64;
    let mut hash = FNV_OFFSET;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        size += read as u64;
    }
    Ok((size, hash))
}

// FNV-1a 64 位参数。摘要只用于核对材料内容是否变化，明确不作为密码学签名。
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn collect(root: &FsPath, plan: &Plan) -> Result<Vec<Value>, String> {
    let files = root.join(FILES_DIR);
    safe_dir(&files).map_err(|_| "材料目录不可用".to_owned())?;
    let mut collected = Vec::with_capacity(plan.materials.len());
    for material in &plan.materials {
        let dir = files.join(&material.blob);
        safe_dir(&dir).map_err(|_| format!("材料目录不可用：{}", material.label))?;
        let (size, hash) = digest(&dir.join(&material.role)).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => format!("材料文件缺失：{}", material.label),
            _ => format!("无法读取材料文件：{}", material.label),
        })?;
        collected.push(json!({
            "role": material.role,
            "label": material.label,
            "name": material.name,
            "size": size,
            "digest": {"algorithm": DIGEST, "value": format!("{hash:016x}")},
        }));
    }
    Ok(collected)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn timestamp(seconds: u64) -> String {
    let (days, rest) = ((seconds / 86_400) as i64, seconds % 86_400);
    let (year, month, day) = civil(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// 把 1970-01-01 起的天数换算成公历日期。
fn civil(days: i64) -> (i64, u64, u64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe as i64 + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn render(
    title: &str,
    type_id: &str,
    requirement: &str,
    sop: &Value,
    materials: &[Value],
) -> String {
    let mut text = format!("# {title}\n\n");
    text.push_str(&format!("- 工作区类型：{type_id}\n"));
    text.push_str(&format!(
        "- SOP：{}@{}（{}）\n",
        sop["id"].as_str().unwrap_or_default(),
        sop["revision"],
        sop["executor"].as_str().unwrap_or_default()
    ));
    text.push_str(&format!("- 生成时间（UTC）：{}\n\n", timestamp(now())));
    text.push_str("## 需求\n\n");
    text.push_str(requirement.trim());
    text.push_str("\n\n## 材料\n\n");
    text.push_str("| 角色 | 文件 | 大小 | 内容校验摘要 |\n| --- | --- | --- | --- |\n");
    for material in materials {
        text.push_str(&format!(
            "| {}（{}） | {} | {} 字节 | FNV-1a64 {} |\n",
            material["label"].as_str().unwrap_or_default(),
            material["role"].as_str().unwrap_or_default(),
            material["name"].as_str().unwrap_or_default(),
            material["size"],
            material["digest"]["value"].as_str().unwrap_or_default(),
        ));
    }
    text.push_str(
        "\n摘要由服务端重新读取材料文件的二进制内容计算，算法为 FNV-1a64，只用于核对内容是否变化，不作为密码学签名。\n",
    );
    text
}

fn outcome(root: &FsPath, workspace: &Value, sop: &Value, plan: &Plan) -> Result<Value, String> {
    let requirement = workspace["requirement"].as_str().unwrap_or_default();
    let type_id = workspace["typeId"].as_str().unwrap_or_default();
    let materials = collect(root, plan)?;
    Ok(json!({
        "typeId": type_id,
        "title": plan.title,
        "requirement": requirement,
        "sop": sop,
        "generatedAt": now(),
        "materials": materials,
        "text": render(&plan.title, type_id, requirement, sop, &materials),
    }))
}

/// 解析本次执行的 SOP 修订：显式引用优先，否则使用类型的推荐默认版本。
fn select(
    db: &Value,
    workspace: &Value,
    requested: Option<workspace_sop::Reference>,
) -> Result<Value, Error> {
    let reference = match requested {
        Some(reference) => reference,
        None => {
            let type_id = workspace["typeId"]
                .as_str()
                .ok_or_else(|| corrupt("typeId"))?;
            workspace_sop::default_reference(type_id).map_err(|_| corrupt("typeId"))?
        }
    };
    workspace_sop::resolve(db, &reference.id, reference.revision)
}

/// 校验、冻结、执行和记录在同一笔更新里完成。执行失败同样留下已冻结的失败尝试。
fn run(db: &mut Value, root: &FsPath, id: &str, request: Request) -> Result<Value, Error> {
    let snapshot = workspace(db, id)?.clone();
    // 版本解析失败时不写库：工作区保持未冻结，也不新增尝试。
    let sop = select(db, &snapshot, request.sop)?;
    let plan = plan(&snapshot, &sop)?;
    let receipt = outcome(root, &snapshot, &sop, &plan);
    let attempt = Uuid::new_v4().to_string();
    let failure = receipt.as_ref().err().cloned();
    let detail = {
        let entry = workspace_mut(db, id)?;
        entry["frozen"] = Value::Bool(true);
        entry
            .get_mut("attempts")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| corrupt("attempts"))?
            .push(match failure {
                None => json!({"id":attempt,"status":"succeeded","sop":sop}),
                Some(error) => json!({"id":attempt,"status":"failed","sop":sop,"error":error}),
            });
        entry.clone()
    };
    if let Ok(mut receipt) = receipt {
        receipt["workspaceId"] = id.into();
        receipt["attemptId"] = attempt.clone().into();
        receipts_mut(db)?.insert(attempt, receipt);
    }
    Ok(detail)
}

fn receipt_text(db: &Value, id: &str, attempt: &str) -> Result<String, Error> {
    let entry = workspace(db, id)?["attempts"]
        .as_array()
        .and_then(|history| history.iter().find(|a| a["id"] == attempt))
        .ok_or_else(|| Error::NotFound("执行尝试不存在".into()))?;
    if entry["status"] != "succeeded" {
        return Err(Error::NotFound("该尝试没有回执".into()));
    }
    db.get(RECEIPTS)
        .and_then(|receipts| receipts.get(attempt))
        .filter(|receipt| receipt["workspaceId"] == id)
        .and_then(|receipt| receipt["text"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| Error::NotFound("回执不存在".into()))
}
