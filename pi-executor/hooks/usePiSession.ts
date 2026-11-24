"use client";

import { useEffect, useState } from "react";
import { ApiError, json, observe, type Snapshot } from "@/lib/pi-session-api";

export function usePiAccess() {
  const [access, setAccess] = useState<{ canWrite: boolean | null; error: string | null }>({ canWrite: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void json<{ canWrite: boolean }>("/access", { signal }).then(
      ({ canWrite }) => { if (!signal.aborted) setAccess({ canWrite, error: null }); },
      (error: Error) => { if (!signal.aborted) setAccess({ canWrite: null, error: error.message }); },
    );
    return () => controller.abort();
  }, []);
  return access;
}

type StreamState = { sessionId: string; snapshot: Snapshot | null; connected: boolean; error: string | null };

export function usePiSessionStream(sessionId: string | null) {
  const [state, setState] = useState<StreamState | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let retry: ReturnType<typeof setTimeout>;
    async function listen(id: string) {
      try {
        await observe(id, signal, snapshot => {
          if (!signal.aborted) setState({ sessionId: id, snapshot, connected: true, error: null });
        });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          setState({ sessionId: id, snapshot: null, connected: false, error: error.message });
          return;
        }
      }
      if (signal.aborted) return;
      setState(previous => previous?.sessionId === id ? { ...previous, connected: false } : previous);
      retry = setTimeout(() => void listen(id), 1500);
    }
    void listen(sessionId);
    return () => { controller.abort(); clearTimeout(retry); };
  }, [sessionId]);
  return state && state.sessionId === sessionId ? state : { snapshot: null, connected: false, error: null };
}
