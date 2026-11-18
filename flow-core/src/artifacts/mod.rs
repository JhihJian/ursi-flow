//! 契约检查与协调错误：artifacts 域对外类型与接口。
//!
//! 本模块是域的对外类型层：错误 [`ArtifactError`]、端口
//! [`ArtifactRepository`] 与契约检查 [`check_contract`] / [`ContractReport`]。
//! 存储实现见 [`store`]；runs 决定节点状态与当前输出，本域只交付事实。

pub mod store;

#[cfg(test)]
mod store_tests;

use async_trait::async_trait;
use crate::domain::{check_artifact_contract, Artifact, ArtifactContract, ArtifactContractError};

use crate::storage::StoreError;

pub use store::{
    ARTIFACT_MIGRATIONS, ArtifactObject, ArtifactRecord, ArtifactStore, PutArtifactRequest,
};

/// 产物域错误：请求错误、不存在、冲突与存储错误可区分。
#[derive(Debug, thiserror::Error)]
pub enum ArtifactError {
    /// 路径或归属字段非法（未触碰存储）。
    #[error("非法产物请求：{0}")]
    Invalid(String),
    /// 产物不存在。
    #[error("产物不存在：{0}")]
    NotFound(String),
    /// 同幂等键携带不同内容或关键元数据（见冲突信息中的字段定位）。
    #[error("幂等冲突：{0}")]
    Conflict(String),
    /// 内容缺失、损坏或与元数据校验信息不符。
    #[error("产物内容错误：{0}")]
    Content(String),
    /// 故障注入触发（仅测试用）。
    #[error("故障注入：内容已落盘但元数据未提交：{0}")]
    Failpoint(String),
    /// 存储层错误。
    #[error("存储错误：{0}")]
    Storage(String),
}

/// 产物存储接口，仅暴露本域数据操作。
#[async_trait]
pub trait ArtifactRepository: Send + Sync {
    async fn list_artifacts(&self, run_id: &str) -> Result<Vec<Artifact>, StoreError>;
}

/// 单条契约项的检查结果：通过或带可定位原因的失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractCheck {
    /// 通过。必需声明携带匹配到的 `artifact_id`（定位产物）；可选声明
    /// 缺失产物时为 `None`（缺失可选产物不算失败）。
    Pass { artifact_id: Option<String> },
    /// 失败；reason 为 domain 错误的完整描述（缺失或类型不匹配）。
    Fail { reason: String },
}

/// 契约检查报告：逐项结果与总体结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractReport {
    /// 与 `declared` 顺序一一对应的逐项结果。
    pub items: Vec<ContractCheck>,
    /// 全部必需声明是否满足。
    pub all_passed: bool,
}

/// 按声明契约逐项检查产物集合（纯函数，只读输入，不写任何状态）。
///
/// 必需声明按 name+path 匹配产物并校验 media_type 兼容，复用
/// `crate::domain::check_artifact_contract`；失败项定位缺失/不匹配原因，
/// 通过项定位匹配到的 artifact_id。
pub fn check_contract(
    declared: &[ArtifactContract],
    listed: &[ArtifactRecord],
) -> ContractReport {
    let mut items = Vec::with_capacity(declared.len());
    for contract in declared {
        let matching: Vec<&ArtifactRecord> = listed
            .iter()
            .filter(|a| a.name == contract.name && a.path == contract.path)
            .collect();
        let domain_views: Vec<Artifact> = matching
            .iter()
            .map(|record| record.to_domain())
            .collect();

        let item = match check_artifact_contract(std::slice::from_ref(contract), &domain_views) {
            Ok(()) => ContractCheck::Pass {
                artifact_id: matching.first().map(|record| record.artifact_id.clone()),
            },
            Err(ArtifactContractError::MissingArtifact { name, path }) => ContractCheck::Fail {
                reason: format!("缺少必需产物：name={name}，path={path}"),
            },
            Err(ArtifactContractError::MediaTypeMismatch {
                name,
                path,
                expected,
                actual,
            }) => ContractCheck::Fail {
                reason: format!("产物 {name}（path={path}）内容类型不匹配：声明 {expected}，实际 {actual}"),
            },
        };
        items.push(item);
    }
    let all_passed = items
        .iter()
        .all(|item| matches!(item, ContractCheck::Pass { .. }));
    ContractReport { items, all_passed }
}

