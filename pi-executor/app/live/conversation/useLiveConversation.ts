import { useEffect, useMemo, useState } from "react";
import type { AgentMessage, AssistantMessage } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { ApiError, json, observe, sessionPath, type Snapshot } from "../api";

export type ConversationNotice = {
  id: string;
  type: "error" | "warning" | "info";
  message: string;
};

export interface ConversationReadModel {
  loading: boolean;
  error: string | null;
  messages: AgentMessage[];
  entryIds: string[];
  partial: AssistantMessage | null;
  activeTool: string | null;
  running: boolean;
  notices: ConversationNotice[];
}

interface ReadState {
  source: { sessionId: string; previewEntryId: string | null };
  snapshot: Snapshot | null;
  connected: boolean;
  error: string | null;
}

const emptyMessages: AgentMessage[] = [];
const emptyEntryIds: string[] = [];

export function useLiveConversation(sessionId: string, previewEntryId: string | null) {
  const { t } = useI18n();
  const source = useMemo(() => ({ sessionId, previewEntryId }), [sessionId, previewEntryId]);
  const [state, setState] = useState<ReadState | null>(null);
  // Never render the previous source (including on the first render of a source change).
  const current = state?.source === source ? state : null;
  const snapshot = current?.snapshot ?? null;
  const error = current?.error ?? null;
  const connected = current?.connected ?? false;
  const previewing = previewEntryId !== null;

  useEffect(() => {
    const lifetime = new AbortController();
    const { signal } = lifetime;
    const { sessionId, previewEntryId } = source;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const receive = (snapshot: Snapshot) => {
      if (!signal.aborted) setState({ source, snapshot, connected: previewEntryId === null, error: null });
    };
    const fail = (error: unknown) => {
      if (!signal.aborted) setState({ source, snapshot: null, connected: false, error: error instanceof Error ? error.message : String(error) });
    };

    if (previewEntryId !== null) {
      void json<Snapshot>(`${sessionPath(sessionId)}?entry=${encodeURIComponent(previewEntryId)}`, { signal }).then(receive, fail);
    } else {
      const listen = async () => {
        try {
          await observe(sessionId, signal, receive);
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
            fail(error);
            return;
          }
        }
        if (signal.aborted) return;
        setState(previous => previous?.source === source ? { ...previous, connected: false } : previous);
        timer = setTimeout(() => void listen(), 1500);
      };
      void listen();
    }
    return () => {
      lifetime.abort();
      clearTimeout(timer);
    };
  }, [source]);

  const notices: ConversationNotice[] = [];
  if (!previewing && !connected && !error) {
    notices.push({ id: "connection", type: "warning", message: t("live.reconnecting") });
  }
  if (!previewing && snapshot && ["failed", "cancelled", "interrupted"].includes(snapshot.status)) {
    notices.push({ id: "status", type: "info", message: t(`live.${snapshot.status}`) });
  }
  const model: ConversationReadModel = {
    loading: !snapshot && !error,
    error,
    messages: snapshot?.messages ?? emptyMessages,
    entryIds: snapshot?.entryIds ?? emptyEntryIds,
    // A historical snapshot may still carry the summary status of a live run.
    running: !previewing && snapshot?.status === "running",
    partial: !previewing && snapshot?.partial?.role === "assistant" ? snapshot.partial : null,
    activeTool: previewing ? null : snapshot?.activeTool ?? null,
    notices,
  };
  return { model, connected };
}
