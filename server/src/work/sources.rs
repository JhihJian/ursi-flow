//! Optional file-backed source routes. Only local configuration selects a provider and package.
mod file;
#[cfg(test)]
mod tests;

use super::{Error, Store, items::create_from_source};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    io,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};

type Reply = Result<Json<Value>, Error>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    providers: Vec<Provider>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    JsonFile,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Provider {
    kind: Kind,
    id: String,
    file: PathBuf,
    actions: Vec<Binding>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    action: String,
    package: String,
    revision: u64,
}

impl Provider {
    fn read(&self) -> Result<Vec<file::Resource>, Error> {
        match self.kind {
            Kind::JsonFile => file::resources(&self.file)
                .map_err(|_| Error::Unavailable("来源导出文件不可用".into())),
        }
    }
    fn item(&self, id: &str) -> Result<file::Resource, Error> {
        self.read()?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or_else(|| Error::NotFound("来源资源不存在".into()))
    }
    fn actions(&self) -> Vec<&str> {
        self.actions.iter().map(|b| b.action.as_str()).collect()
    }
}

#[derive(Clone)]
struct Sources {
    store: Store,
    providers: Arc<BTreeMap<String, Provider>>,
}
impl Sources {
    fn provider(&self, id: &str) -> Result<&Provider, Error> {
        self.providers
            .get(id)
            .ok_or_else(|| Error::NotFound("来源不存在".into()))
    }
}

pub(super) fn routes(store: Store) -> io::Result<Router> {
    configured(
        store,
        std::env::var_os("URSI_WORK_SOURCES")
            .as_deref()
            .map(FsPath::new),
    )
}

fn configured(store: Store, path: Option<&FsPath>) -> io::Result<Router> {
    let Some(path) = path else {
        return Ok(Router::new());
    };
    let cfg: Config = file::read_json(path, file::CONFIG_LIMIT)?;
    let mut providers = BTreeMap::new();
    for p in cfg.providers {
        let mut actions = std::collections::BTreeSet::new();
        if !file::name(&p.id)
            || !p.file.is_absolute()
            || p.actions.is_empty()
            || p.actions.iter().any(|b| {
                !file::name(&b.action)
                    || !file::name(&b.package)
                    || b.revision == 0
                    || !actions.insert(&b.action)
            })
        {
            return Err(file::invalid());
        }
        if providers.insert(p.id.clone(), p).is_some() {
            return Err(file::invalid());
        }
    }
    Ok(Router::new()
        .route("/v2/sources", get(index))
        .route("/v2/sources/{provider}/items", get(list))
        .route("/v2/sources/{provider}/items/{id}", get(detail))
        .route("/v2/sources/{provider}/items/{id}/dispatch", post(dispatch))
        .layer(DefaultBodyLimit::max(4096))
        .with_state(Sources {
            store,
            providers: Arc::new(providers),
        }))
}

async fn index(State(s): State<Sources>) -> Json<Value> {
    Json(Value::Array(
        s.providers
            .values()
            .map(|p| json!({"id":p.id,"kind":p.kind,"actions":p.actions()}))
            .collect(),
    ))
}

async fn blocking(f: impl FnOnce() -> Result<Value, Error> + Send + 'static) -> Reply {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| Error::Internal("来源读取任务中断".into()))?
        .map(Json)
}

async fn list(State(s): State<Sources>, Path(provider): Path<String>) -> Reply {
    blocking(move || {
        Ok(Value::Array(
            s.provider(&provider)?
                .read()?
                .into_iter()
                .map(|i| json!({"id":i.id,"title":i.title}))
                .collect(),
        ))
    })
    .await
}

async fn detail(State(s): State<Sources>, Path((provider, id)): Path<(String, String)>) -> Reply {
    blocking(move || {
        let p = s.provider(&provider)?;
        let i = p.item(&id)?;
        Ok(json!({"id":i.id,"title":i.title,"input":i.input,"actions":p.actions()}))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Dispatch {
    request_id: String,
    action: String,
}

async fn dispatch(
    State(s): State<Sources>,
    Path((provider, id)): Path<(String, String)>,
    Json(req): Json<Dispatch>,
) -> Reply {
    blocking(move || {
        let p = s.provider(&provider)?;
        let binding = p
            .actions
            .iter()
            .find(|b| b.action == req.action)
            .ok_or_else(|| Error::Invalid("来源未开放此动作".into()))?;
        let item = p.item(&id)?;
        let source = Map::from_iter([
            ("type".into(), "connector".into()),
            ("provider".into(), p.id.clone().into()),
            ("itemId".into(), item.id.into()),
            ("action".into(), binding.action.clone().into()),
        ]);
        s.store.update(|db| {
            let work = create_from_source(
                db,
                &req.request_id,
                &binding.package,
                binding.revision,
                item.input,
                source,
            )?;
            if work["packageSnapshot"]["actions"]
                .get(&binding.action)
                .is_none()
            {
                return Err(Error::Conflict("来源动作与工作包版本不匹配".into()));
            }
            Ok(json!({"id":work["id"],"status":work["status"]}))
        })
    })
    .await
}
