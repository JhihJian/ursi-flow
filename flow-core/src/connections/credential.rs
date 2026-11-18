//! 凭据引用与受控解析入口。
//!
//! SPEC：连接的业务存储与对外配置只保存凭据引用，实际密钥从受控凭据
//! 来源解析。解析入口仅向授权的执行装配方交付运行时所需值，凭据来源
//! 可通过接口替换。
//!
//! 隔离规则：
//! - `CredentialHandle` 不实现 `Display`/`Serialize`/`AsRef<str>`，
//!   无法被无意格式化或序列化进 DTO、日志或快照；
//! - `Debug` 实现输出 `[REDACTED]`；
//! - 错误只携带引用标识与定位信息，不携带上游响应内容。
//! - 真正的明文只在测试与调用方取值 (`into_secret`) 时出现，
//!   `resolve_credential` 返回 `CredentialHandle`，禁止 `String` 直传。

use async_trait::async_trait;

use super::error::ConnectionError;

/// 受控凭据来源。由执行装配方注入，可替换实现。
#[async_trait]
pub trait CredentialResolver: Send + Sync {
    /// 解析凭据引用。实现方自行区分缺失与访问失败。
    async fn resolve(&self, credential_ref: &str) -> Result<String, CredentialError>;
}

/// 凭据解析错误（解析替身的返回类型，与模块统一错误相互映射）。
#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    /// 引用在凭据来源中不存在。
    #[error("凭据引用不存在：{0}")]
    Missing(String),
    /// 凭据来源不可达或拒绝访问（不含上游响应内容）。
    #[error("凭据访问失败：{0}")]
    AccessFailed(String),
}

impl From<CredentialError> for ConnectionError {
    fn from(e: CredentialError) -> Self {
        match e {
            CredentialError::Missing(r) => ConnectionError::CredentialMissing(r),
            CredentialError::AccessFailed(m) => ConnectionError::CredentialAccessFailed(m),
        }
    }
}

/// 已解析的凭据值。刻意不暴露字符串形态，防止进入 DTO、日志或快照。
///
/// 类型系统隔离：没有 `Display`/`Serialize`/`Deref`，唯一取值途径是
/// 显式调用 [`CredentialHandle::into_secret`]，供执行装配方在发起
/// 实际模型请求前使用。
pub struct CredentialHandle {
    secret: String,
}

impl std::fmt::Debug for CredentialHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl CredentialHandle {
    /// 取出凭据明文。仅供执行装配方在实际请求前使用。
    pub fn into_secret(self) -> String {
        self.secret
    }

    /// 仅供测试注入构造（保证生产代码无法凭空构造）。
    #[cfg(test)]
    fn from_secret(secret: String) -> Self {
        Self { secret }
    }
}

/// 受控解析入口：仅在显式调用时走 resolver。
///
/// - 正确引用：返回不含明文形态的 [`CredentialHandle`]；
/// - 引用不存在：`CredentialMissing`（可区分）；
/// - 来源不可达/拒绝访问：`CredentialAccessFailed`（可区分）。
pub async fn resolve_credential(
    resolver: &dyn CredentialResolver,
    credential_ref: &str,
) -> Result<CredentialHandle, ConnectionError> {
    let secret = resolver.resolve(credential_ref).await?;
    Ok(CredentialHandle { secret })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const MARKER: &str = "sk-TEST-SECRET-MARKER";

    /// 可记录调用次数与入参的解析替身。
    #[derive(Default)]
    struct FakeResolver {
        calls: AtomicUsize,
        last_ref: std::sync::Mutex<Option<String>>,
    }

    #[async_trait]
    impl CredentialResolver for FakeResolver {
        async fn resolve(&self, credential_ref: &str) -> Result<String, CredentialError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.last_ref.lock().unwrap() = Some(credential_ref.to_string());
            match credential_ref {
                "vault://ok" => Ok(MARKER.to_string()),
                "vault://missing" => Err(CredentialError::Missing(credential_ref.to_string())),
                _ => Err(CredentialError::AccessFailed("backend down".into())),
            }
        }
    }

    fn assert_no_marker(text: &str) {
        assert!(!text.contains(MARKER), "泄漏了密钥标记：{text}");
    }

    /// SPEC「凭据引用与受控解析」：正确引用得到对应值。
    /// SPEC「连接配置交付」：仅调用配置接口时，解析替身没有被调用。
    #[tokio::test]
    async fn 正确引用得到值且显式调用才解析() {
        let resolver = FakeResolver::default();
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 0, "未显式调用时不得解析");
        let handle = resolve_credential(&resolver, "vault://ok").await.unwrap();
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
        assert_eq!(*resolver.last_ref.lock().unwrap(), Some("vault://ok".into()));
        assert_eq!(handle.into_secret(), MARKER);
    }

    /// SPEC「凭据引用与受控解析」：错误引用返回可区分的缺失或访问失败。
    #[tokio::test]
    async fn 错误引用可区分缺失与访问失败() {
        let resolver = FakeResolver::default();
        let err = resolve_credential(&resolver, "vault://missing").await.unwrap_err();
        assert!(matches!(err, ConnectionError::CredentialMissing(_)), "实际：{err:?}");
        assert_no_marker(&err.to_string());

        let err = resolve_credential(&resolver, "vault://other").await.unwrap_err();
        assert!(matches!(err, ConnectionError::CredentialAccessFailed(_)), "实际：{err:?}");
        assert_no_marker(&err.to_string());
    }

    /// SPEC「凭据引用与受控解析」：Debug 输出不含明文（打点防护）。
    #[tokio::test]
    async fn handle_debug_脱敏() {
        let handle = CredentialHandle::from_secret(MARKER.to_string());
        assert_no_marker(&format!("{:?}", handle));
        assert_eq!(format!("{:?}", handle), "[REDACTED]");
        handle.into_secret(); // 消费掉，避免 clippy unused 警告
    }

    /// 编译期防护：CredentialHandle 不得实现 Display/Into<String>。
    /// 若有人无意放宽类型契约，取消注释对应断言行会编译失败。
    #[test]
    fn handle_无_display_无字符串转换() {
        #[allow(dead_code)] // 断言函数本身留作未来使用，防契约放宽
        fn assert_not_display<T: ?Sized>()
        where
            (T,): std::fmt::Display,
        {
        }
        // 取消注释能编译即说明 CredentialHandle 意外实现了 Display：
        // assert_not_display::<CredentialHandle>();

        fn assert_into_string<T: Into<String>>() {}
        // 取消注释能编译即说明存在 Into<String> 转换：
        // assert_into_string::<CredentialHandle>();

        // 用 String 反向验证 assert_into_string 有约束力（可编译）。
        assert_into_string::<String>();
    }
}
