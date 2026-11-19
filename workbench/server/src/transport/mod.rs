//! Bearer 鉴权的 Runtime API。
mod error;
mod http;

use crate::flow::FlowService;
use axum::{
    Router,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use error::error;
use std::sync::Arc;

pub fn router(service: FlowService, token: String) -> Router {
    protected(http::routes(service), token)
}

pub(crate) fn combined(flow: Option<FlowService>, work: Router, token: String) -> Router {
    let routes = match flow {
        Some(s) => work.merge(http::routes(s)),
        None => work,
    };
    protected(routes, token)
}

fn protected(routes: Router, token: String) -> Router {
    let api = routes
        .fallback(|| async { error(StatusCode::NOT_FOUND) })
        .layer(middleware::from_fn_with_state(
            Arc::<str>::from(token),
            authenticate,
        ));
    Router::new().nest_service("/api", api)
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
