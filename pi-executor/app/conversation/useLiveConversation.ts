import { useEffect, useState } from "react";
import type { AgentMessage, AssistantMessage } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { usePiSessionStream } from "@/hooks/usePiSession";
import { json, sessionPath, type Snapshot } from "@/lib/pi-session-api";

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

const emptyMessages: AgentMessage[] = [];
const emptyEntryIds: string[] = [];

export function useLiveConversation(sessionId: string, entryId: string | null): ConversationReadModel {
  const { t } = useI18n();
  const path = entryId === null ? null : `${sessionPath(sessionId)}?entry=${encodeURIComponent(entryId)}`;
  const stream = usePiSessionStream(path === null ? sessionId : null);
  const [history, setHistory] = useState<{ path: string; snapshot: Snapshot | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const { signal } = controller;
    void json<Snapshot>(path, { signal }).then(
      snapshot => { if (!signal.aborted) setHistory({ path, snapshot, error: null }); },
      (error: Error) => { if (!signal.aborted) setHistory({ path, snapshot: null, error: error.message }); },
    );
    return () => controller.abort();
  }, [path]);
  const current = path === null ? stream : history?.path === path ? history : null;
  const snapshot = current?.snapshot ?? null;
  const error = current?.error ?? null;
  const notices: ConversationNotice[] = [];
  if (path === null && snapshot && !stream.connected && !error) {
    notices.push({ id: "connection", type: "warning", message: t("live.reconnecting") });
  }
  if (path === null && snapshot && ["failed", "cancelled", "interrupted"].includes(snapshot.status)) {
    notices.push({ id: "status", type: "info", message: t(`live.${snapshot.status}`) });
  }
  return {
    loading: !snapshot && !error,
    error,
    messages: snapshot?.messages ?? emptyMessages,
    entryIds: snapshot?.entryIds ?? emptyEntryIds,
    running: path === null && snapshot?.status === "running",
    partial: path === null && snapshot?.partial?.role === "assistant" ? snapshot.partial : null,
    activeTool: path === null ? snapshot?.activeTool ?? null : null,
    notices,
  };
}
