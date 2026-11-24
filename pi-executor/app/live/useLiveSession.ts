import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentPhase, NoticeItem, useAgentSession } from "@/hooks/useAgentSession";
import type { ChatInputHandle } from "@/components/ChatInput";
import { useI18n } from "@/hooks/useI18n";
import { isScrollAtTail } from "@/lib/chat-lazy-load";
import { CONFIGURED_TOOL_PRESET } from "@/lib/tool-presets";
import { ApiError, json, observe, sessionPath, type Snapshot, type Summary } from "./api";
import type { LiveWorkspace } from "./workspace";

type DemoAgent = ReturnType<typeof useAgentSession>;
export type ChatDriver = Partial<DemoAgent> & Pick<DemoAgent,
  "loading" | "error" | "messages" | "entryIds" | "streamState" | "agentRunning" | "isNew" |
  "sessionIdRef" | "scrollContainerRef" | "lastUserMsgRef" | "handleSend" | "handleAbort" |
  "scrollToBottom" | "scrollToMessage" | "scrollUserMsgToTop" | "toolPreset"
>;

export function useLiveSession(live: LiveWorkspace, id: string, composer?: React.RefObject<ChatInputHandle | null>): ChatDriver {
  const { canWrite } = live;
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const command = useRef<AbortController | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(id);
  const follow = useRef(true);
  const running = snapshot?.status === "running";

  useEffect(() => {
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function listen() {
      try {
        await observe(id, lifetime.signal, next => {
          if (lifetime.signal.aborted) return;
          setSnapshot(next);
          setConnected(true);
        });
      } catch (error) {
        if (lifetime.signal.aborted) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) { setError(error.message); return; }
      }
      if (lifetime.signal.aborted) return;
      setConnected(false);
      timer = setTimeout(() => void listen(), 1500);
    }
    void listen();
    return () => { lifetime.abort(); clearTimeout(timer); command.current?.abort(); };
  }, [id]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    follow.current = true;
    const el = scrollContainerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);
  const scrollToMessage = useCallback((target: HTMLElement, offset = 0) => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - offset;
  }, []);
  const hasSnapshot = snapshot !== null;
  useEffect(() => {
    if (!hasSnapshot) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      follow.current = isScrollAtTail(el.scrollTop, el.clientHeight, el.scrollHeight, 48);
      setShowScrollToBottom(!follow.current);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasSnapshot]);
  useEffect(() => { if (follow.current) scrollToBottom(); }, [snapshot, scrollToBottom]);

  const handleSend: DemoAgent["handleSend"] = useCallback(async message => {
    if (!canWrite || command.current || !connected || running) {
      composer?.current?.insertIfEmpty(message);
      return;
    }
    const controller = new AbortController();
    command.current = controller;
    setSubmitting(true);
    setCommandError(null);
    follow.current = true;
    try {
      const next = await json<Summary>(`${sessionPath(id)}/prompt`, {
        method: "POST", body: JSON.stringify({ message }), signal: controller.signal,
      });
      if (!controller.signal.aborted) setSnapshot(previous =>
        previous && previous.updatedAt < next.updatedAt ? { ...previous, ...next } : previous);
    } catch (error) {
      if (controller.signal.aborted) return;
      setCommandError(error instanceof Error ? error.message : String(error));
      composer?.current?.insertIfEmpty(message);
    } finally {
      if (!controller.signal.aborted) { command.current = null; setSubmitting(false); }
    }
  }, [id, canWrite, connected, running, composer]);

  const handleAbort = useCallback(async () => {
    if (!canWrite || command.current || !connected || !running) return;
    const controller = new AbortController();
    command.current = controller;
    setCommandError(null);
    try {
      await json(`${sessionPath(id)}/cancel`, { method: "POST", signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      setCommandError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) command.current = null;
    }
  }, [id, canWrite, connected, running]);

  const messages = useMemo(() => snapshot?.messages ?? [], [snapshot?.messages]);
  const entryIds = useMemo(() => messages.map((message, index) => `${message.timestamp ?? 0}:${index}`), [messages]);
  const notices: NoticeItem[] = [];
  if (commandError) notices.push({ id: "command", type: "error", message: commandError });
  if (!connected && !error) notices.push({ id: "connection", type: "warning", message: t("live.reconnecting") });
  if (snapshot && ["failed", "cancelled", "interrupted"].includes(snapshot.status)) {
    notices.push({ id: "status", type: "info", message: t(`live.${snapshot.status}`) });
  }
  const agentPhase: AgentPhase = snapshot?.activeTool ? {
    kind: "running_tools", tools: [{ id: snapshot.activeTool, name: snapshot.activeTool }],
  } : running ? { kind: "waiting_model" } : null;
  const assistant = messages.findLast(item => item.role === "assistant");
  return {
    loading: !snapshot && !error, error, messages, entryIds,
    streamState: { isStreaming: running, streamingMessage: snapshot?.partial?.role === "assistant" ? snapshot.partial : null },
    agentPhase, agentRunning: running, isNew: false, notices,
    sessionIdRef, scrollContainerRef, lastUserMsgRef, showScrollToBottom, scrollToBottom, scrollToMessage,
    scrollUserMsgToTop: () => {}, handleSend, handleAbort, toolPreset: CONFIGURED_TOOL_PRESET,
    displayModel: assistant?.role === "assistant" ? { provider: assistant.provider, modelId: assistant.model } : null,
    modelSwitching: submitting,
  };
}
