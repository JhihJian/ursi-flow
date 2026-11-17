//! HTTP 接口层。
//!
//! 暴露工作流的创建、解析校验与查询，运行的启动、状态查询与审批操作，
//! 以及观测事件的流式订阅（SSE），供 web 页面与外部调用方使用。
//! 本 crate 只做协议暴露与参数校验，不包含业务编排逻辑。

use std::sync::Arc;

use ursi_engine::Engine;
use ursi_observe::Subscriber;
use ursi_repo::Store;

/// 启动 HTTP 服务（骨架占位，后续实现路由与 SSE 推送）。
pub async fn serve(
    engine: Arc<Engine>,
    store: Arc<dyn Store>,
    subscriber: Arc<dyn Subscriber>,
) -> Result<(), ApiError> {
    let _ = (engine, store, subscriber);
    Err(ApiError::NotImplemented("serve".to_string()))
}

/// API 错误。
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("功能尚未实现：{0}")]
    NotImplemented(String),
}
