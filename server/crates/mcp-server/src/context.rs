//! 运行上下文与身份参数校验。

use serde::{Deserialize, Serialize};

/// 运行上下文：内部工具域调用的身份来源。
///
/// 由运行时在发起内部工具调用时注入，工具实现只从这里取 run/node 身份，
/// 禁止从调用参数读取。运维域与控制域的工具不消费身份，server 对缺失
/// 上下文的这类调用传入 [`InvocationContext::detached`] 占位。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvocationContext {
    pub run_id: String,
    pub node_id: String,
    pub session_id: String,
}

impl InvocationContext {
    pub fn new(
        run_id: impl Into<String>,
        node_id: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            node_id: node_id.into(),
            session_id: session_id.into(),
        }
    }

    /// 无身份占位上下文：仅用于不读取身份的运维域/控制域调用。
    pub fn detached() -> Self {
        Self::default()
    }

    /// 同 [`InvocationContext::detached`]，语义化别名供 server 骨架使用。
    pub fn detached_placeholder() -> Self {
        Self::detached()
    }

    /// 是否为无身份占位。
    pub fn is_detached(&self) -> bool {
        self.run_id.is_empty()
    }
}

/// 内部工具域禁止从参数传入的身份键（snake_case 与 camelCase 顶层键）。
pub const FORBIDDEN_IDENTITY_KEYS: &[&str] = &[
    "run_id",
    "node_id",
    "session_id",
    "runId",
    "nodeId",
    "sessionId",
];

/// 返回 args 顶层出现的身份键。参数校验层据此拒绝内部域调用，
/// 只检查顶层键，不递归嵌套对象。
pub fn detect_identity_args(args: &serde_json::Value) -> Vec<String> {
    let Some(map) = args.as_object() else {
        return Vec::new();
    };
    FORBIDDEN_IDENTITY_KEYS
        .iter()
        .copied()
        .filter(|key| map.contains_key(*key))
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn new_and_detached() {
        let ctx = InvocationContext::new("run-1", "node-a", "sess-1");
        assert_eq!(ctx.run_id, "run-1");
        assert!(!ctx.is_detached());
        assert!(InvocationContext::detached().is_detached());
        assert_eq!(InvocationContext::default(), InvocationContext::detached());
    }

    #[test]
    fn detects_top_level_identity_keys() {
        let snake = json!({ "run_id": "run-9", "artifact_id": "art-1" });
        assert_eq!(detect_identity_args(&snake), vec!["run_id".to_string()]);

        let camel = json!({ "nodeId": "n1", "sessionId": "s1" });
        let keys = detect_identity_args(&camel);
        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&"nodeId".to_string()));
        assert!(keys.contains(&"sessionId".to_string()));
    }

    #[test]
    fn nested_identity_keys_are_not_rejected() {
        let args = json!({ "filter": { "run_id": "run-9" } });
        assert!(detect_identity_args(&args).is_empty());
    }

    #[test]
    fn non_object_args_have_no_identity() {
        assert!(detect_identity_args(&json!([])).is_empty());
        assert!(detect_identity_args(&serde_json::Value::Null).is_empty());
    }
}
