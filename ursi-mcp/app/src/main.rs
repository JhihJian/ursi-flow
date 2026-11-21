mod store;

use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State},
    http::{HeaderValue, StatusCode, header, uri::Authority},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::OpenOptions,
    io::{self, Read},
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
};
use store::{Store, open_private};
use subtle::ConstantTimeEq;
use tower_http::services::{ServeDir, ServeFile};
use ursi_mcp::{McpPlatform, PolicyMode};

#[derive(Clone)]
struct Access {
    token_hash: [u8; 32],
    https_host: Option<Authority>,
}

fn required_path(name: &str) -> io::Result<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other(format!("请设置 {name}")))
}
fn token_hash(path: &std::path::Path) -> io::Result<[u8; 32]> {
    let mut bytes = Vec::new();
    open_private(OpenOptions::new().read(true), path)?
        .take(1026)
        .read_to_end(&mut bytes)?;
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    if !(32..=1024).contains(&bytes.len()) || !bytes.iter().all(u8::is_ascii_graphic) {
        return Err(io::Error::other(
            "管理令牌必须为 32 至 1024 个非空格可打印 ASCII 字符",
        ));
    }
    Ok(Sha256::digest(bytes).into())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind: SocketAddr = env::var("URSI_MCP_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8087".into())
        .parse()?;
    let https_host = match env::var("URSI_MCP_HTTPS_HOST") {
        Ok(value) => {
            let host: Authority = value.parse()?;
            if host.host().is_empty() || value.contains('@') {
                return Err(io::Error::other("HTTPS Host 无效").into());
            }
            Some(host)
        }
        Err(env::VarError::NotPresent) => None,
        Err(e) => return Err(e.into()),
    };
    let web = match env::var_os("URSI_MCP_WEB_DIR") {
        Some(value) => PathBuf::from(value),
        None => env::current_exe()?.with_file_name("web"),
    }
    .canonicalize()?;
    let index = web.join("index.html");
    if !index.is_file() || !web.join("assets").is_dir() {
        return Err(io::Error::other("缺少管理台网页文件").into());
    }
    let token_file = required_path("URSI_MCP_TOKEN_FILE")?;
    let access = Access {
        token_hash: token_hash(&token_file)?,
        https_host,
    };
    let store = Arc::new(Store::open(&required_path("URSI_MCP_DATA_DIR")?)?);
    if store.dir.starts_with(&web)
        || web.starts_with(&store.dir)
        || token_file.canonicalize()?.starts_with(&web)
    {
        return Err(io::Error::other("网页、数据和令牌文件必须隔离").into());
    }
    let platform = McpPlatform::with_policy_mode(
        store.clone(),
        store.clone(),
        store.dir.join("mcp-policy.json"),
        "ursi-mcpd",
        env!("CARGO_PKG_VERSION"),
        PolicyMode::RequiredManagedCredentials,
    );
    let api = Router::new()
        .merge(platform.routes())
        .merge(credentials(store))
        .fallback(|| async { failure(StatusCode::NOT_FOUND, "API 不存在") })
        .layer(middleware::from_fn_with_state(access.clone(), authenticate));
    let app = Router::new()
        .nest("/api/v2", api)
        .nest_service(
            "/assets",
            ServeDir::new(web.join("assets")).append_index_html_on_directories(false),
        )
        .route_service("/", ServeFile::new(&index))
        .route_service("/mcp-servers", ServeFile::new(&index))
        .route_service("/mcp-servers/{id}", ServeFile::new(&index))
        .route_service("/platform-env", ServeFile::new(&index))
        .layer(middleware::from_fn_with_state(access, boundary));
    let listener = tokio::net::TcpListener::bind(bind).await?;
    eprintln!("ursi-mcpd listening at {}", listener.local_addr()?);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

fn failure(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

async fn authenticate(State(access): State<Access>, request: Request, next: Next) -> Response {
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.as_bytes().strip_prefix(b"Bearer "))
        .filter(|value| (32..=1024).contains(&value.len()))
        .is_some_and(|value| bool::from(access.token_hash.ct_eq(Sha256::digest(value).as_ref())));
    if !authorized {
        return failure(StatusCode::UNAUTHORIZED, "管理令牌无效");
    }
    next.run(request).await
}

async fn boundary(
    State(access): State<Access>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<Authority>().ok());
    let allowed = peer.ip().to_canonical().is_loopback()
        && host.as_ref().is_some_and(|host| match &access.https_host {
            Some(expected) => host.as_str().eq_ignore_ascii_case(expected.as_str()),
            None => {
                host.host().eq_ignore_ascii_case("localhost")
                    || host
                        .host()
                        .trim_matches(['[', ']'])
                        .parse::<IpAddr>()
                        .is_ok_and(|ip| ip.to_canonical().is_loopback())
            }
        });
    if !allowed {
        return failure(StatusCode::FORBIDDEN, "请求来源未启用");
    }
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        let scheme = if access.https_host.is_some() {
            "https"
        } else {
            "http"
        };
        let expected = format!("{scheme}://{}", host.as_ref().unwrap());
        if !origin
            .to_str()
            .is_ok_and(|value| value.eq_ignore_ascii_case(&expected))
        {
            return failure(StatusCode::FORBIDDEN, "仅接受同源请求");
        }
    }
    let asset = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if !asset {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

fn credentials(store: Arc<Store>) -> Router {
    Router::new()
        .route("/platform-env", get(names).post(create))
        .route("/platform-env/{name}", put(replace).delete(remove))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(store)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
    value: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Replace {
    value: String,
}
async fn names(State(store): State<Arc<Store>>) -> Result<Json<Vec<String>>, ursi_mcp::Error> {
    store.names().map(Json)
}
async fn create(
    State(store): State<Arc<Store>>,
    Json(input): Json<Create>,
) -> Result<Response, ursi_mcp::Error> {
    set(&store, input.name, input.value, false)
}
async fn replace(
    State(store): State<Arc<Store>>,
    Path(name): Path<String>,
    Json(input): Json<Replace>,
) -> Result<Response, ursi_mcp::Error> {
    set(&store, name, input.value, true)
}
fn set(
    store: &Store,
    name: String,
    value: String,
    replace: bool,
) -> Result<Response, ursi_mcp::Error> {
    Ok(match store.set_credential(name.clone(), value, replace)? {
        Ok(()) => Json(json!({"name": name})).into_response(),
        Err(StatusCode::CONFLICT) => failure(StatusCode::CONFLICT, "变量已存在"),
        Err(_) => failure(StatusCode::NOT_FOUND, "变量不存在"),
    })
}
async fn remove(
    State(store): State<Arc<Store>>,
    Path(name): Path<String>,
) -> Result<Response, ursi_mcp::Error> {
    Ok(if store.remove_credential(&name)? {
        Json(json!({"name": name})).into_response()
    } else {
        failure(StatusCode::NOT_FOUND, "变量不存在")
    })
}
