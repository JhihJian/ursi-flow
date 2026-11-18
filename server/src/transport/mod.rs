//! Bearer 鉴权的 Runtime API 与公开的静态页面。
mod error;
mod http;
mod static_assets;

use crate::flow::FlowService;
use axum::{
    Router,
    extract::{Request, State},
    http::{StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use error::error;
use std::{path::PathBuf, sync::Arc};

pub fn router(service: FlowService, token: String, static_root: Option<PathBuf>) -> Router {
    let api = http::routes(service)
        .fallback(|| async { error(StatusCode::NOT_FOUND) })
        .layer(middleware::from_fn_with_state(
            Arc::<str>::from(token),
            authenticate,
        ));
    Router::new()
        .nest_service("/api", api)
        .fallback_service(get(move |uri: Uri| {
            let root = static_root.clone();
            async move { static_assets::serve(root, uri.path()).await }
        }))
}

async fn authenticate(State(token): State<Arc<str>>, req: Request, next: Next) -> Response {
    let mut headers = req.headers().get_all(header::AUTHORIZATION).iter();
    let authorized = headers
        .next()
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.split_once(' '))
        .is_some_and(|(scheme, value)| {
            scheme.eq_ignore_ascii_case("bearer") && !value.is_empty() && value == &*token
        });
    if authorized && headers.next().is_none() {
        next.run(req).await
    } else {
        (
            [(header::WWW_AUTHENTICATE, "Bearer")],
            error(StatusCode::UNAUTHORIZED),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests;
