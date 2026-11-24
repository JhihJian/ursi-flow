import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { ApiError, json, type Summary } from "./api";

export const liveCwd = "/Pi Sessions";

export function liveSessionInfo(id: string, summary?: Summary): SessionInfo {
  const date = summary ? new Date(summary.updatedAt).toISOString() : "";
  return {
    id, name: summary?.title || undefined, modified: date, created: date, messageCount: 0,
    firstMessage: "", path: "", cwd: liveCwd, projectRoot: liveCwd, projectKey: liveCwd,
  };
}

export function useLiveWorkspace(token: string, canWrite: boolean, onDisconnect: () => void) {
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useRef<AbortController | null>(null);
  const opening = useRef(false);
  const refresh = useCallback(async () => {
    list.current?.abort();
    const controller = new AbortController();
    list.current = controller;
    try {
      const data = await json<{ sessions: Summary[] }>(token, "/sessions", { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSummaries(data.sessions);
      setError(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) onDisconnect();
      else setError(String(error instanceof Error ? error.message : error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [token, onDisconnect]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      await refresh();
      if (!stopped) timer = setTimeout(() => void poll(), 2500);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); list.current?.abort(); };
  }, [refresh]);

  const create = useCallback(async () => {
    if (!canWrite || opening.current) return null;
    opening.current = true;
    setCreating(true);
    try {
      const summary = await json<Summary>(token, "/sessions", { method: "POST", body: "{}" });
      setSummaries(previous => [summary, ...previous.filter(item => item.id !== summary.id)]);
      void refresh();
      return liveSessionInfo(summary.id, summary);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      opening.current = false;
      setCreating(false);
    }
  }, [token, canWrite, refresh]);

  const sessions = useMemo(() => summaries.map(s => liveSessionInfo(s.id, s)), [summaries]);
  const running = useMemo(() => summaries.filter(s => s.status === "running").map(s => s.id), [summaries]);
  return { token, canWrite, onDisconnect, sessions, running, loading, error, creating, refresh, create };
}

export type LiveWorkspace = ReturnType<typeof useLiveWorkspace>;