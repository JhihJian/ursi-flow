import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { json, type RuntimeInfo, type Summary } from "./api";

export const liveCwd = "/Pi Sessions";

export function liveSessionInfo(id: string, summary?: Summary): SessionInfo {
  const date = summary ? new Date(summary.updatedAt).toISOString() : "";
  return {
    id, name: summary?.title || undefined, modified: date, created: date, messageCount: 0,
    firstMessage: "", path: "", cwd: liveCwd, projectRoot: liveCwd, projectKey: liveCwd,
  };
}

export function useLiveWorkspace() {
  const [canWrite, setCanWrite] = useState<boolean | null>(null);
  const access = useRef<boolean | null>(null);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const list = useRef<AbortController | null>(null);
  const opening = useRef(false);
  const refresh = useCallback(async () => {
    list.current?.abort();
    const controller = new AbortController();
    list.current = controller;
    try {
      const options = { signal: controller.signal };
      const canWrite = access.current ?? (await json<{ canWrite: boolean }>("/access", options)).canWrite;
      const data = await json<{ sessions: Summary[] }>("/sessions", options);
      if (controller.signal.aborted) return;
      access.current = canWrite;
      setCanWrite(canWrite);
      setSummaries(data.sessions);
      setError(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

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

  const hasAccess = canWrite !== null;
  useEffect(() => {
    if (!hasAccess) return;
    const controller = new AbortController();
    void json<RuntimeInfo>("/runtime", { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setRuntime(data);
    }, error => {
      if (!controller.signal.aborted) setRuntimeError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [hasAccess]);

  const create = useCallback(async () => {
    if (!canWrite || opening.current) return null;
    opening.current = true;
    setCreating(true);
    try {
      const summary = await json<Summary>("/sessions", { method: "POST", body: "{}" });
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
  }, [canWrite, refresh]);

  const sessions = useMemo(() => summaries.map(s => liveSessionInfo(s.id, s)), [summaries]);
  const running = useMemo(() => summaries.filter(s => s.status === "running").map(s => s.id), [summaries]);
  return { canWrite, sessions, running, loading, error, creating, refresh, create, runtime, runtimeError };
}

export type LiveWorkspace = ReturnType<typeof useLiveWorkspace>;