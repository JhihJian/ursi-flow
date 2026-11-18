//! 运行时能力描述查询与配置可用性判断。
//!
//! SPEC：通过注入的能力描述接口读取执行器对服务类型、模型连接参数
//! 及认证方式的支持情况。connections 依据描述结果提供配置可用性判断，
//! 能力来源负责描述适配范围。
//!
//! 三态语义（调用方可区分 Unknown 与确定不支持）：
//! - `Match`：描述可用且连接的服务类型在支持集合内；
//! - `Mismatch`：描述可用但服务类型不在支持集合内（确定不支持）；
//! - `Unknown`：描述接口不可用或返回内容无法解释（不是确定不支持）。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::error::ConnectionError;
use super::model::{ModelConnection, ServiceType};

/// 执行器能力描述接口（由 app 注入，真实实现由沙箱 session-service 装配）。
#[async_trait]
pub trait CapabilityDescriptor: Send + Sync {
    /// 读取执行器支持的服务类型集合与参数描述。只读，不产生执行副作用。
    async fn describe(&self) -> Result<CapabilityReport, ConnectionError>;
}

/// 能力描述报告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityReport {
    /// 报告覆盖的服务类型集合（连接的服务类型须落在其中）。
    pub supported_service_types: Vec<ServiceType>,
    /// 支持的认证方式（如 `bearer`、`x-api-key`），供执行装配参考。
    pub auth_methods: Vec<String>,
    /// 连接参数描述（如默认超时、上下文长度），自由文本字段。
    pub parameters: Vec<(String, String)>,
}

/// 能力判断三态结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityCheck {
    /// 连接配置与执行器能力匹配。
    Match,
    /// 描述可用，但连接的服务类型确定不被支持。
    Mismatch,
    /// 描述接口不可用或内容无法解释，匹配情况未知（区别于确定不支持）。
    Unknown(String),
}

/// 配置可用性判断：读取能力描述，比对连接服务类型。
///
/// 只读语义：仅调用 `describe()`，不触发执行、不修改角色。
/// 三态语义：
/// - `Ok(Match)` / `Ok(Mismatch)`：描述可用，匹配结论确定；
/// - `Ok(Unknown)`：描述接口不可用或内容无法解释，结论未知；
/// - `Err(e)`：模块级异常（如存储层异常），非能力判断语义。
/// 调用方通过结果值区分 "确定不支持" 与 "未知"。
pub async fn check_capability(
    descriptor: &dyn CapabilityDescriptor,
    connection: &ModelConnection,
) -> Result<CapabilityCheck, ConnectionError> {
    // 能力来源不可用时不得透传上游错误文本（可能含敏感内容），
    // 只保留粗粒度的分层原因。
    let report = match descriptor.describe().await {
        Ok(r) => r,
        Err(e) => {
            let reason = match e {
                ConnectionError::CapabilityMismatch(_) => "描述内容无效",
                _ => "描述接口不可用",
            };
            return Ok(CapabilityCheck::Unknown(reason.to_string()));
        }
    };
    if report
        .supported_service_types
        .iter()
        .any(|t| t == &connection.service_type)
    {
        Ok(CapabilityCheck::Match)
    } else {
        Ok(CapabilityCheck::Mismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const MARKER: &str = "TEST-CAP-MARKER";

    /// 按构造参数返回支持/不支持/不可用/无效内容四种形态的替身，
    /// 并记录 describe 调用次数（只读断言用）。
    enum FakeDescriptor {
        Supports(AtomicUsize, Vec<ServiceType>),
        Unavailable(AtomicUsize),
        InvalidContent(AtomicUsize),
    }

    impl FakeDescriptor {
        fn calls(&self) -> &AtomicUsize {
            match self {
                FakeDescriptor::Supports(c, _) => c,
                FakeDescriptor::Unavailable(c) => c,
                FakeDescriptor::InvalidContent(c) => c,
            }
        }
    }
    #[async_trait]
    impl CapabilityDescriptor for FakeDescriptor {
        async fn describe(&self) -> Result<CapabilityReport, ConnectionError> {
            self.calls().fetch_add(1, Ordering::SeqCst);
            match self {
                FakeDescriptor::Supports(_, types) => Ok(CapabilityReport {
                    supported_service_types: types.clone(),
                    auth_methods: vec!["bearer".into()],
                    parameters: Vec::new(),
                }),
                FakeDescriptor::Unavailable(_) => Err(ConnectionError::Storage(MARKER.into())),
                FakeDescriptor::InvalidContent(_) => Err(ConnectionError::CapabilityMismatch(MARKER.into())),
            }
        }
    }

    fn conn(st: ServiceType) -> ModelConnection {
        ModelConnection {
            id: "c1".into(),
            name: "n".into(),
            service_type: st,
            endpoint: "https://api.example.com".into(),
            credential_ref: "vault://k".into(),
            created_at: None,
        }
    }

    fn usable(types: Vec<ServiceType>) -> FakeDescriptor {
        FakeDescriptor::Supports(AtomicUsize::new(0), types)
    }

    /// SPEC「运行时能力描述查询」：注入两种能力描述，同一连接按各自
    /// 支持范围返回匹配或不匹配。
    #[tokio::test]
    async fn 同一连接按两种描述得到匹配与不匹配() {
        let openai = conn(ServiceType::OpenAiCompatible);
        let a = usable(vec![ServiceType::OpenAiCompatible, ServiceType::Anthropic]);
        let b = usable(vec![ServiceType::Anthropic]);
        assert_eq!(
            check_capability(&a, &openai).await.unwrap(),
            CapabilityCheck::Match
        );
        assert_eq!(
            check_capability(&b, &openai).await.unwrap(),
            CapabilityCheck::Mismatch
        );
    }

    /// SPEC「运行时能力描述查询」：接口不可用返回可区分的 Unknown，
    /// 与确定不支持（Mismatch）不同；错误不透传上游内容。
    #[tokio::test]
    async fn 描述不可用返回_unknown_且可区分() {
        let c = conn(ServiceType::OpenAiCompatible);
        let unavailable = FakeDescriptor::Unavailable(AtomicUsize::new(0));
        let result = check_capability(&unavailable, &c).await.unwrap();
        assert!(matches!(result, CapabilityCheck::Unknown(_)), "实际：{result:?}");
        assert!(!format!("{result:?}").contains(MARKER), "结果泄漏了上游内容");
        // 区分性：同样的连接对可用描述返回确定结果。
        let ok = usable(vec![ServiceType::Anthropic]);
        assert_eq!(check_capability(&ok, &c).await.unwrap(), CapabilityCheck::Mismatch);
    }

    /// SPEC「运行时能力描述查询」：描述内容无法解释同样归为 Unknown。
    #[tokio::test]
    async fn 描述内容无效归为_unknown() {
        let c = conn(ServiceType::OpenAiCompatible);
        let bad = FakeDescriptor::InvalidContent(AtomicUsize::new(0));
        let result = check_capability(&bad, &c).await.unwrap();
        assert!(matches!(result, CapabilityCheck::Unknown(_)));
    }

    /// SPEC「运行时能力描述查询」：能力查询只读，不触发执行会话、
    /// 调度节点或角色修改；调用记录只有 describe 本身。
    #[tokio::test]
    async fn 能力查询只读且只调用_describe() {
        let d = usable(vec![ServiceType::Anthropic]);
        let calls_before = d.calls().load(Ordering::SeqCst);
        let c = conn(ServiceType::Anthropic);
        let _ = check_capability(&d, &c).await.unwrap();
        assert_eq!(
            d.calls().load(Ordering::SeqCst),
            calls_before + 1,
            "一次查询只应调用一次 describe"
        );
        // FakeDescriptor 只有 describe 一个入口，无执行/调度/角色修改接口，
        // 编译层面即不存在这些副作用；调用计数证明查询没有额外触发任何操作。
    }
}
