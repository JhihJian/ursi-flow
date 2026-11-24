import { useEffect, useMemo, useState } from "react";
import { parsePiJsonl, TrajectoryViewer } from "pi-agent-trajectory-viewer";
import { fetchMeta, fetchSessionText, type SessionMeta } from "./api";

type LoadState =
  | { status: "idle"; meta?: undefined }
  | { status: "loading"; meta?: SessionMeta }
  | { status: "ready"; meta: SessionMeta; text: string }
  | { status: "error"; message: string; meta?: SessionMeta };

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session") ?? "";
/** 被看板工作台嵌入时不再画自己的头部，避免和宿主的两条栏叠在一起。 */
const embedded = params.get("embed") === "1";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function SessionShell() {
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    if (!sessionId) {
      setState({ status: "error", message: "缺少 ?session=<id> 参数" });
      return;
    }
    let alive = true;
    void (async () => {
      setState({ status: "loading" });
      try {
        const meta = await fetchMeta(sessionId);
        if (!alive) return;
        if (meta.tooLarge) {
          setState({
            status: "error",
            message: `会话 ${formatBytes(meta.size)}，超过服务端上限`,
            meta,
          });
          return;
        }
        setState({ status: "loading", meta });
        const text = await fetchSessionText(sessionId);
        if (!alive) return;
        setState({ status: "ready", meta, text });
      } catch (error) {
        if (!alive) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const parsed = useMemo(() => {
    if (state.status !== "ready") return null;
    try {
      return { ok: true as const, value: parsePiJsonl(state.text) };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, [state]);

  const meta = state.meta;

  return (
    <div className="viewer-shell">
      {embedded ? null : (
        <header className="viewer-bar">
          <span className="viewer-title">Session</span>
          <code className="viewer-id">{sessionId || "—"}</code>
          {meta ? (
            <>
              <span className="viewer-meta">
                {meta.project ?? meta.projectDir}
              </span>
              <span className="viewer-meta">
                {formatBytes(meta.size)} · {formatTime(meta.mtime)} ·{" "}
                {meta.format}
              </span>
            </>
          ) : null}
          {parsed?.ok ? (
            <span className="viewer-meta">
              {parsed.value.stats.turns} turns · {parsed.value.stats.messages}{" "}
              messages · {parsed.value.stats.tools} tools
            </span>
          ) : null}
          <a
            className="viewer-source"
            href={`/api/sessions/${sessionId}/text`}
            target="_blank"
            rel="noreferrer"
          >
            Raw JSONL ↗
          </a>
        </header>
      )}

      <main className="viewer-main">
        {state.status === "idle" || state.status === "loading" ? (
          <div className="viewer-center">
            <span className="viewer-hint">Loading session…</span>
            {state.meta && state.meta.size > 8 * 1024 * 1024 ? (
              <span className="viewer-hint">
                {formatBytes(state.meta.size)} 会话，解析需要几秒
              </span>
            ) : null}
          </div>
        ) : null}

        {state.status === "error" ? (
          <div className="viewer-center">
            <span className="viewer-error">{state.message}</span>
            <span className="viewer-hint">
              服务端在 `SESSION_VIEWER_ROOTS` 配置的目录里查找
              `*_&lt;sessionId&gt;.jsonl`。
            </span>
          </div>
        ) : null}

        {parsed && !parsed.ok ? (
          <div className="viewer-center">
            <span className="viewer-error">解析失败：{parsed.message}</span>
            <span className="viewer-hint">
              可用右上角的 Raw JSONL 检查原始内容。
            </span>
          </div>
        ) : null}

        {parsed?.ok ? (
          <TrajectoryViewer
            turns={parsed.value.turns}
            sessionRevision={state.status === "ready" ? state.meta.mtime : 0}
          />
        ) : null}
      </main>
    </div>
  );
}
