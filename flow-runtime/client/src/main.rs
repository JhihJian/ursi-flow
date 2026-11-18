use serde_json::{Map, Value, json};
use std::{env, fs, io, path::Path};
use ursi_flow_client::{FlowClient, Result};
const USAGE: &str = "ursi-flow config get|set <JSON>\nursi-flow flow list|get <ID>|validate <ID> <目录>|create <ID> <目录>|update <ID> <目录>|delete <ID>\nursi-flow run start <Flow ID> [变量JSON] [Run ID] | list|get <Run ID>|stop <Run ID>|history <Run ID>";
fn files(root: &Path) -> Result<Value> {
    fn visit(root: &Path, name: &str, map: &mut Map<String, Value>) -> Result<()> {
        let path = root.join(name);
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            for ent in fs::read_dir(path)? {
                let child = ent?
                    .file_name()
                    .into_string()
                    .map_err(|_| io::Error::other("文件名不是 UTF-8"))?;
                visit(root, &format!("{name}/{child}"), map)?;
            }
        } else if meta.is_file() {
            map.insert(name.into(), Value::String(fs::read_to_string(path)?));
        } else {
            return Err(io::Error::other("不接受符号链接或特殊文件"));
        }
        Ok(())
    }
    let mut map = Map::new();
    visit(root, "FLOW.md", &mut map)?;
    for sub in ["scripts", "references"] {
        if root.join(sub).try_exists()? {
            visit(root, sub, &mut map)?;
        }
    }
    Ok(Value::Object(map))
}
fn main() {
    if let Err(e) = entry() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
fn entry() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    let a: Vec<_> = args.iter().map(String::as_str).collect();
    if a == ["--help"] || a == ["-h"] {
        println!("{USAGE}");
        return Ok(());
    }
    let c = FlowClient::from_env()?;
    let result = match a.as_slice() {
        ["config", "get"] => c.config(),
        ["config", "set", patch] => c.configure(serde_json::from_str(patch)?),
        ["flow", "list"] => c.flows(),
        ["flow", "get", id] => c.flow(id),
        ["flow", "validate", id, path] => c.validate(id, files(Path::new(path))?),
        ["flow", "create", id, path] => c.create(id, files(Path::new(path))?),
        ["flow", "update", id, path] => c.update(id, files(Path::new(path))?),
        ["flow", "delete", id] => c.delete(id),
        ["run", "list"] => c.runs(),
        ["run", "get", id] => c.run(id),
        ["run", "stop", id] => c.stop(id),
        ["run", "history", id] => c.history(id),
        ["run", "start", flow, rest @ ..] if rest.len() <= 2 => {
            let id = rest
                .get(1)
                .map(|v| v.to_string())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let vars = rest
                .first()
                .map(|s| serde_json::from_str(s))
                .transpose()?
                .unwrap_or(json!({}));
            c.start(&id, flow, &env::current_dir()?, vars)
        }
        _ => Err(io::Error::other(USAGE)),
    }?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
