//! HTTP 接口层。
//!
//! 暴露工作流的创建、解析校验与查询，运行的启动、状态查询与审批操作，
//! 以及观测事件的流式订阅（SSE），供 web 页面与外部调用方使用。
//! 本模块负责协议暴露与参数校验，业务用例由各域公开接口提供。

use std::sync::Arc;

use crate::runs::{RunRepository, engine::Engine};

/// 启动 HTTP 服务（骨架占位，后续实现路由与 SSE 推送）。
pub async fn serve(engine: Arc<Engine>, store: Arc<dyn RunRepository>) -> Result<(), ApiError> {
    let _ = (engine, store);
    Err(ApiError::NotImplemented("serve".to_string()))
}

/// API 错误。
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("功能尚未实现：{0}")]
    NotImplemented(String),
}
