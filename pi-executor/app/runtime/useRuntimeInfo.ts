import { useEffect, useMemo, useState } from "react";
import { ApiError, json, sessionPath, type RuntimeInfo } from "@/lib/pi-session-api";

export function useRuntimeInfo(sessionId: string | null) {
  const path = sessionId ? `${sessionPath(sessionId)}/runtime` : "/runtime";
  const source = useMemo(() => ({ path, refresh: sessionId !== null && sessionId !== "", enabled: sessionId !== "" }), [path, sessionId]);
  const [result, setResult] = useState<{ source: typeof source; runtime: RuntimeInfo | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!source.enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      let refresh = source.refresh;
      try {
        const runtime = await json<RuntimeInfo>(source.path, { signal });
        if (!signal.aborted) setResult({ source, runtime, error: null });
      } catch (error) {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) refresh = false;
        if (!signal.aborted) setResult({ source, runtime: null, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!signal.aborted && refresh) timer = setTimeout(() => void load(), 3000);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [source]);

  return result?.source === source ? result : { runtime: null, error: null };
}
