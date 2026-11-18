//! 可控时钟：以毫秒时基注入当前时间。
//!
//! 租约到期与 updated_at 都取自注入时钟，测试用手动推进的
//! [`super::FakeClock`] 模拟租约到期（SPEC「状态提交、租约与取消」验收）。

/// 时钟接口：返回 Unix 纪元起的毫秒数。
pub trait Clock: Send + Sync {
    fn now_millis(&self) -> i64;
}

/// 系统真实时钟，供装配使用。
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_millis(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}
