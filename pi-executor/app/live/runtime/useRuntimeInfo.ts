import { useEffect, useMemo, useState } from "react";
import { json, sessionPath, type RuntimeInfo } from "../api";

export function useRuntimeInfo(enabled: boolean, sessionId: string | null, running: boolean) {
  const path = sessionId ? `${sessionPath(sessionId)}/runtime` : "/runtime";
  const source = useMemo(() => ({ path, enabled }), [path, enabled]);
  const [result, setResult] = useState<{ source: typeof source; runtime: RuntimeInfo | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!source.enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const runtime = await json<RuntimeInfo>(source.path, { signal });
        if (!signal.aborted) setResult({ source, runtime, error: null });
      } catch (error) {
        if (!signal.aborted) setResult({ source, runtime: null, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!signal.aborted && running) timer = setTimeout(() => void load(), 2000);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [source, running]);

  return result?.source === source ? result : { runtime: null, error: null };
}
