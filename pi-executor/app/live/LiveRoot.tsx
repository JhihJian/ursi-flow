"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { demoAssetPath } from "@/mock/base-path";
import { ApiError, json } from "./api";
import { useLiveWorkspace } from "./workspace";

const storageKey = "ursi-pi-session-token";

function remember(token: string) {
  try {
    if (token) sessionStorage.setItem(storageKey, token);
    else sessionStorage.removeItem(storageKey);
  } catch { /* Browser storage is optional. */ }
}

export function LiveRoot() {
  return <I18nProvider><LoginGate /></I18nProvider>;
}

function LoginGate() {
  const { t } = useI18n();
  const [auth, setAuth] = useState<{ token: string; canWrite: boolean } | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(true);
  const attempt = useRef<AbortController | null>(null);

  const connect = useCallback(async (token: string) => {
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setConnecting(true);
    setError("");
    try {
      const role = await json<{ canWrite: boolean }>(token, "/access", { signal: controller.signal });
      if (controller.signal.aborted) return;
      remember(token);
      setAuth({ token, canWrite: role.canWrite });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) remember("");
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
    }
  }, []);

  useEffect(() => {
    let cached = "";
    try { cached = sessionStorage.getItem(storageKey) ?? ""; } catch { /* Browser storage is optional. */ }
    if (cached) void connect(cached);
    else setConnecting(false);
    return () => attempt.current?.abort();
  }, [connect]);

  const disconnect = useCallback(() => {
    remember("");
    setAuth(null);
  }, []);

  if (auth) return <LiveWorkspaceView {...auth} onDisconnect={disconnect} />;
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 text-text">
      <form className="flex w-full max-w-xs flex-col gap-3" onSubmit={event => {
        event.preventDefault();
        const token = String(new FormData(event.currentTarget).get("token") ?? "").trim();
        if (token) void connect(token);
      }}>
        <h1 className="flex items-center gap-2 font-mono-font text-xl font-bold">
          <Image src={demoAssetPath("/icons/apple-touch-icon.png")} width={32} height={32} alt="" />Pi Web
        </h1>
        <label htmlFor="pi-token" className="text-sm text-text-muted">{t("live.token")}</label>
        <input id="pi-token" name="token" type="password" autoComplete="off" required disabled={connecting}
          className="rounded-[7px] border border-border bg-bg-panel px-3 py-2 outline-none focus:border-accent" />
        <button type="submit" disabled={connecting} className="config-button config-button-default config-button-primary self-end">
          {t(connecting ? "live.connecting" : "live.connect")}
        </button>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      </form>
    </main>
  );
}

function LiveWorkspaceView({ token, canWrite, onDisconnect }: { token: string; canWrite: boolean; onDisconnect: () => void }) {
  const workspace = useLiveWorkspace(token, canWrite, onDisconnect);
  return <AppShell live={workspace} />;
}
