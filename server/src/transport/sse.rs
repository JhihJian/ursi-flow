//! SSE 事件流：GET /api/v1/runs/{id}/events（text/event-stream）。
//!
//! ## 实现模式（已文档化的选型）
//!
//! 采用「实时流只作通知、数据始终从持久源增量拉取」的可靠模式
//!（SPEC「事件流与重放」：通知是广播，数据库事件是历史重放与断线补读的
//! 事实来源）：
//!
//! 1. 建立订阅（[`ports::EventFeed::subscribe`]）拿到实时通知通道；
//! 2. 先按游标补读历史（`read_since`），逐帧推送；
//! 3. 再挂实时流：每个通知只当作"有新事件"的信号，数据始终回源
//!    `read_since(last_sent)` 增量拉取；
//! 4. 慢消费者丢帧天然安全：通知丢了也不会丢数据，下一帧到达或重连时
//!    从持久源补齐；每帧携带单调 seq，客户端可按 seq 连续性检测缺口。
//!
//! 去重规则：先补读历史（读到当前持久源末尾），再消费实时通知；交界
//! 处事件按 seq 去重——实时通知回源拉取时只取 `seq > last_sent` 的记录，
//! 因此每个事件恰好输出一次。
//!
//! 游标：`?after=<seq>` 只允许非负整数；无效游标（abc / -1 / 1.5）返回
//! 400 / invalid_cursor 明确错误，不建立流。重连携带上次收到的最大 seq
//! 即无缝续读。事件帧内也带 `seq`（游标），客户端可继续读取。
//!
//! 断开释放：客户端断开导致响应流被 drop，通知通道 Receiver 随之 drop，
//! runs 实现据此释放订阅资源；运行继续执行不受影响。

use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use futures_util::Stream;
use serde::Deserialize;
use std::sync::Arc;

use crate::transport::error::ApiError;
use crate::transport::ports::{EventFeed, NumberedEvent};
use crate::transport::AppState;

/// `?after=` 查询参数。
#[derive(Debug, Deserialize)]
pub struct EventsQuery {
    after: Option<String>,
}

/// 解析游标。只允许非负整数；非法值返回明确错误（400 / invalid_cursor）。
pub fn parse_cursor(raw: Option<&str>) -> Result<u64, ApiError> {
    match raw {
        None => Ok(0),
        Some(raw) => {
            if raw.is_empty() {
                return Err(ApiError::InvalidCursor {
                    message: "游标不能为空".to_string(),
                });
            }
            raw.parse::<u64>().map_err(|_| ApiError::InvalidCursor {
                message: format!("游标必须是 0 或正整数：{raw}"),
            })
        }
    }
}

/// SSE 事件流服务。data 负载是 EventFrame JSON，SSE `id:` 也是 seq，
/// 供 EventSource 自动重连与客户端游标记录。
pub async fn run_events(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let after = parse_cursor(query.after.as_deref())?;
    let feed = Arc::clone(&state.events);

    // 先建立实时订阅，再补读历史（避免交界窗口丢通知）。
    let live = feed.subscribe(&run_id);
    // 历史补读：run 不存在时替身/真实实现返回 NotFound，SSE 握手即失败。
    feed.read_since(&run_id, after).await?;

    let stream = EventPullStream::new(feed, live, run_id, after);
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

/// 「实时流只作通知、数据始终回源增量拉取」的拉取式事件流。
///
/// 建流时立即回源补读一次历史（`read_since(last_sent)`，含游标续读），
/// 之后每个实时通知触发一次增量补读：通知丢失不丢数据（慢消费者安全），
/// 重复通知不重发（按 last_sent 去重），交界处事件恰好输出一次。
pub(crate) struct EventPullStream {
    feed: Arc<dyn EventFeed>,
    /// 实时通知通道。拉取期间临时移入 future，结束时随结果归还；
    /// None 表示通道已关闭（订阅释放），只回源兜底。
    live: Option<tokio::sync::mpsc::Receiver<NumberedEvent>>,
    run_id: String,
    last_sent: u64,
    /// 当前待输出的帧队列。
    pending: std::vec::IntoIter<Result<SseEvent, Infallible>>,
    /// 流状态机：首轮补读（不等通知）或「等通知 -> 回源拉取」进行中。
    /// live 每轮随 future 移动并在结束时归还，保证跨轮复用（receiver
    /// 若随 future 一次性丢失，后续轮不再等通知，read_since 空转成
    /// busy-loop，卡死 current-thread runtime）。
    state: PullState,
    /// 持久源故障后发送错误帧并结束流。
    terminated: bool,
}

type PullFuture = Pin<
    Box<
        dyn Future<
            Output = (
                Option<tokio::sync::mpsc::Receiver<NumberedEvent>>,
                Result<Vec<NumberedEvent>, ApiError>,
            ),
        > + Send,
    >,
>;

enum PullState {
    /// 首轮回源补读（不等通知）。
    Priming,
    /// 等待下一个实时通知（下一轮拉取前先 recv）。
    Waiting,
    /// 「（等通知）-> 回源拉取」future 进行中，跨 poll 推进。
    Pulling(PullFuture),
}

use std::future::Future;

impl EventPullStream {
    /// 测试专用：直接构造流。
    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn new_for_test(
        feed: Arc<dyn EventFeed>,
        live: tokio::sync::mpsc::Receiver<NumberedEvent>,
        run_id: String,
        after: u64,
    ) -> Self {
        Self::new(feed, live, run_id, after)
    }

    fn new(
        feed: Arc<dyn EventFeed>,
        live: tokio::sync::mpsc::Receiver<NumberedEvent>,
        run_id: String,
        after: u64,
    ) -> Self {
        EventPullStream {
            feed,
            live: Some(live),
            run_id,
            last_sent: after,
            pending: Vec::new().into_iter(),
            state: PullState::Priming,
            terminated: false,
        }
    }

    /// 启动一轮回源拉取：通知通道移入 future，结束时随结果归还。
    fn start_pull(&mut self) {
        let feed = Arc::clone(&self.feed);
        let run_id = self.run_id.clone();
        let last_sent = self.last_sent;
        let mut live = self.live.take();
        let priming = matches!(self.state, PullState::Priming);
        self.state = PullState::Pulling(Box::pin(async move {
            // 首轮直接回源补读历史/游标后续；之后等下一个实时通知再
            // 拉取。通道关闭时 recv 返回 None，仍回源拉取一次兜底，由
            // 客户端断开结束本流。
            if !priming {
                if let Some(live) = live.as_mut() {
                    let _ = live.recv().await;
                }
            }
            let result = feed.read_since(&run_id, last_sent).await;
            (live, result)
        }));
    }
}

impl Stream for EventPullStream {
    type Item = Result<SseEvent, Infallible>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            if let Some(frame) = this.pending.next() {
                return Poll::Ready(Some(frame));
            }
            if this.terminated {
                return Poll::Ready(None);
            }
            // 状态机：首轮不等通知直接补读；之后每轮等通知再回源拉取。
            if matches!(this.state, PullState::Priming | PullState::Waiting) {
                this.start_pull();
            }
            let PullState::Pulling(fut) = &mut this.state else {
                unreachable!("Priming/Waiting 已立即转为 Pulling");
            };
            match fut.as_mut().poll(cx) {
                Poll::Ready((live, result)) => {
                    // 归还通知通道；下一轮先等通知再回源拉取。
                    this.live = live;
                    this.state = PullState::Waiting;
                    match result {
                        Ok(events) if !events.is_empty() => {
                            let mut frames = Vec::with_capacity(events.len());
                            for event in events {
                                this.last_sent = this.last_sent.max(event.seq);
                                frames.push(Ok(to_sse_event(&event)));
                            }
                            this.pending = frames.into_iter();
                        }
                        Ok(_) => {}
                        Err(err) => {
                            // 持久源故障：发送一条脱敏错误帧后结束流
                            //（客户端携带游标重连即可续读）。
                            let frame = serde_json::json!({
                                "error": { "code": err.code(), "message": err.message() }
                            });
                            this.pending = vec![Ok(SseEvent::default()
                                .event("error")
                                .data(frame.to_string()))]
                                .into_iter();
                            this.terminated = true;
                        }
                    }
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// NumberedEvent -> SSE 帧：`id: <seq>`、`event: telemetry`、data 为 JSON。
fn to_sse_event(event: &NumberedEvent) -> SseEvent {
    let frame = serde_json::json!({
        "seq": event.seq,
        "category": event.event.category,
        "name": event.event.name,
        "phase": event.event.phase,
        "message": event.event.message,
        "attributes": event.event.attributes,
    });
    SseEvent::default()
        .id(event.seq.to_string())
        .event("telemetry")
        .data(frame.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC「事件流与重放」：无效游标返回明确错误。
    #[test]
    fn cursor_rejects_non_integer() {
        assert!(parse_cursor(Some("abc")).is_err());
        assert!(parse_cursor(Some("-1")).is_err());
        assert!(parse_cursor(Some("1.5")).is_err());
        assert!(parse_cursor(Some("")).is_err());
        assert_eq!(parse_cursor(Some("0")).unwrap(), 0);
        assert_eq!(parse_cursor(Some("42")).unwrap(), 42);
        assert_eq!(parse_cursor(None).unwrap(), 0);
        let err = parse_cursor(Some("abc")).unwrap_err();
        assert_eq!(err.code(), "invalid_cursor");
    }

    /// SSE 帧包含 seq 游标与事件内容（经响应体验证完整帧文本）。
    #[tokio::test]
    async fn sse_frame_carries_cursor_and_payload() {
        use flow_core::domain::{EventCategory, EventPhase, TelemetryEvent};
        let event = NumberedEvent {
            run_id: "run-1".into(),
            seq: 7,
            event: TelemetryEvent {
                category: EventCategory::Node,
                name: "node-a".into(),
                phase: EventPhase::Start,
                message: "开始执行".into(),
                attributes: Default::default(),
            },
        };
        let sse = Sse::new(futures_util::stream::iter(vec![
            Ok::<_, Infallible>(to_sse_event(&event)),
        ]));
        let response = axum::response::IntoResponse::into_response(sse);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("id: 7"), "text={text}");
        assert!(text.contains("event: telemetry"));
        assert!(text.contains("\"seq\":7"));
        assert!(text.contains("node-a"));
    }
}
