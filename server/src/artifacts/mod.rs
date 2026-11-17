//! 产物管理：内容、元数据及运行、节点、执行轮次归属。
//!
//! 本模块提供内容和契约检查结果，runs 决定节点状态与当前有效输出。
//! 当前保留产物查询骨架，内容存取及验收契约见 SPEC.md。

use async_trait::async_trait;
use ursi_domain::Artifact;

use crate::storage::StoreError;

/// 产物存储接口，仅暴露本域数据操作。
#[async_trait]
pub trait ArtifactRepository: Send + Sync {
    async fn list_artifacts(&self, run_id: &str) -> Result<Vec<Artifact>, StoreError>;
}
