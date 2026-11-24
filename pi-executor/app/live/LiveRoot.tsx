"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput";
import { MessageView } from "@/components/MessageView";
import { I18nProvider } from "@/hooks/useI18n";
import type { ToolResultMessage } from "@/lib/types";
import { ApiError, json, observe, sessionPath, statuses, type Snapshot, type Summary } from "./api";
import styles from "./live.module.css";

const storageKey = "ursi-pi-session-token";
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败";

function readToken() {
  try { return sessionStorage.getItem(storageKey) ?? ""; } catch { return ""; }
}

function saveToken(token: string) {
  try {
    if (token) sessionStorage.setItem(storageKey, token);
    else sessionStorage.removeItem(storageKey);
  } catch { /* Keep the credential in memory when storage is unavailable. */ }
}

function selectedSession() { return new URL(location.href).searchParams.get("session") ?? ""; }

export function LiveRoot() {
  const [token, setToken] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [access, setAccess] = useState<{ canWrite: boolean } | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const attempt = useRef<AbortController | null>(null);

  async function connect(credential: string) {
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setConnecting(true);
    setError("");
    try {
      const role = await json<{ canWrite: boolean }>(credential, "/access", { signal: controller.signal });
      if (controller.signal.aborted) return;
      saveToken(credential);
      setToken(credential);
      setAccess(role);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) saveToken("");
      setError(errorText(error));
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
    }
  }

  useEffect(() => {
    setHydrated(true);
    const cached = readToken();
    if (cached) void connect(cached);
    return () => attempt.current?.abort();
  }, []);

  function disconnect() {
    saveToken("");
    setToken("");
    setAccess(null);
  }

  return <I18nProvider>
    <main className={styles.root} lang="zh-CN">
      {access ? <Workspace token={token} canWrite={access.canWrite} onDisconnect={disconnect} /> :
        <form className={styles.login} onSubmit={event => {
          event.preventDefault();
          const credential = String(new FormData(event.currentTarget).get("token") ?? "").trim();
          if (credential) void connect(credential);
        }}>
          <h1>Pi Web · 实时会话</h1>
          <label htmlFor="pi-token">会话令牌</label>
          <input id="pi-token" name="token" type="password" autoComplete="off" required disabled={!hydrated || connecting} />
          <button type="submit" disabled={!hydrated || connecting}>{connecting ? "连接中…" : "连接"}</button>
          {error && <p role="alert" className={styles.error}>{error}</p>}
        </form>}
    </main>
  </I18nProvider>;
}

function Workspace({ token, canWrite, onDisconnect }: { token: string; canWrite: boolean; onDisconnect: () => void }) {
  const [id, setId] = useState(selectedSession);
  const [sessions, setSessions] = useState<Summary[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const listRequest = useRef<AbortController | null>(null);

  async function refresh() {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setError("");
    try {
      const data = await json<{ sessions: Summary[] }>(token, "/sessions", { signal: controller.signal });
      if (!controller.signal.aborted) setSessions(data.sessions);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorText(error));
    }
  }

  useEffect(() => {
    const onPopState = () => setId(selectedSession());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    void refresh();
    return () => listRequest.current?.abort();
    // The workspace mounts with a validated credential and unmounts on sign-out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function select(next: string) {
    if (next !== id) {
      const url = new URL(location.href);
      if (next) url.searchParams.set("session", next);
      else url.searchParams.delete("session");
      window.history.pushState(null, "", url);
      setId(next);
    }
  }

  async function create() {
    setCreating(true);
    setError("");
    try {
      const session = await json<Summary>(token, "/sessions", { method: "POST", body: "{}" });
      select(session.id);
      await refresh();
    } catch (error) { setError(errorText(error)); }
    finally { setCreating(false); }
  }

  return <>
    <header className={styles.bar}>
      <h1>Pi Web <span>实时会话</span></h1>
      <span className={styles.mode}>{canWrite ? "可对话" : "只读"}</span>
      <button type="button" onClick={onDisconnect}>断开</button>
    </header>
    <div className={styles.workspace}>
      <aside className={styles.sidebar} aria-label="会话列表">
        <div className={styles.actions}>
          <button type="button" onClick={() => void refresh()}>刷新</button>
          {canWrite && <button type="button" disabled={creating} onClick={() => void create()}>新建会话</button>}
        </div>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <ul className={styles.sessions}>
          {sessions.map(session => <li key={session.id}>
            <button type="button" title={session.title || session.id}
              aria-current={id === session.id ? "true" : undefined} onClick={() => select(session.id)}>
              {session.title || "未命名会话"}
            </button>
          </li>)}
        </ul>
      </aside>
      {id ? <Conversation key={id} token={token} id={id} canWrite={canWrite} /> :
        <p className={styles.empty}>未选择会话</p>}
    </div>
  </>;
}

function Conversation({ token, id, canWrite }: { token: string; id: string; canWrite: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(false);
  const [streamError, setStreamError] = useState("");
  const [commandError, setCommandError] = useState("");
  const [command, setCommand] = useState<"sending" | "cancelling" | null>(null);
  const commandRef = useRef(false);
  const composer = useRef<ChatInputHandle>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const tail = useRef(true);
  const running = snapshot?.status === "running";

  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    async function listen() {
      try {
        await observe(token, id, controller.signal, data => {
          if (controller.signal.aborted) return;
          setSnapshot(data);
          setOnline(true);
          setStreamError("");
        });
        if (controller.signal.aborted) return;
        setStreamError("连接已断开，正在重连…");
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          setOnline(false);
          setStreamError(error.message);
          return;
        }
        setStreamError("连接失败，正在重连…");
      }
      setOnline(false);
      retry = setTimeout(() => void listen(), 1500);
    }
    void listen();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [id, token]);

  useEffect(() => {
    if (tail.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [snapshot]);

  const toolResults = useMemo(() => new Map((snapshot?.messages ?? [])
    .filter((message): message is ToolResultMessage => message.role === "toolResult")
    .map(message => [message.toolCallId, message])), [snapshot]);

  async function send(message: string) {
    if (commandRef.current || !online || running) return;
    commandRef.current = true;
    setCommand("sending");
    setCommandError("");
    tail.current = true;
    try {
      const next = await json<Summary>(token, `${sessionPath(id)}/prompt`, { method: "POST", body: JSON.stringify({ message }) });
      // An event may already have reported completion by the time the command responds.
      setSnapshot(previous => previous && previous.updatedAt < next.updatedAt ? { ...previous, ...next } : previous);
    } catch (error) {
      setCommandError(errorText(error));
      composer.current?.insertIfEmpty(message);
    } finally { commandRef.current = false; setCommand(null); }
  }

  async function cancel() {
    if (commandRef.current) return;
    commandRef.current = true;
    setCommand("cancelling");
    setCommandError("");
    try { await json(token, `${sessionPath(id)}/cancel`, { method: "POST" }); }
    catch (error) { setCommandError(errorText(error)); }
    finally { commandRef.current = false; setCommand(null); }
  }

  return <section className={styles.conversation} aria-label="当前会话">
    <header className={styles.sessionBar}>
      <div className={styles.sessionIdentity}>
        <h2>{snapshot?.title || "未命名会话"}</h2>
        <code title={id}>{id}</code>
      </div>
      <span className={styles.mode} role="status">{snapshot ? statuses[snapshot.status] : "等待会话"}</span>
      {canWrite && running && <button type="button" onClick={() => void cancel()} disabled={!online || !!command}>停止</button>}
    </header>
    {streamError && <p role="alert" className={styles.error}>{streamError}</p>}
    <div className={styles.transcript} ref={transcript} onScroll={event => {
      const el = event.currentTarget;
      tail.current = el.scrollHeight - el.clientHeight - el.scrollTop < 48;
    }}>
      <div className={styles.messages}>
        {snapshot?.messages.filter(message => message.role !== "toolResult").map((message, index) =>
          <MessageView key={`${message.role}:${message.timestamp}:${index}`} message={message} toolResults={toolResults} />)}
        {snapshot?.partial && <MessageView message={snapshot.partial} toolResults={toolResults} isStreaming />}
        {snapshot?.activeTool && <p className={styles.activity}>正在运行：{snapshot.activeTool}</p>}
        {snapshot && !snapshot.messages.length && !snapshot.partial && <p className={styles.empty}>暂无消息</p>}
      </div>
    </div>
    {canWrite && <footer className={styles.composer}>
      {commandError && <p role="alert" className={styles.error}>{commandError}</p>}
      <ChatInput ref={composer} compact onSend={message => void send(message)} onAbort={() => void cancel()}
        isStreaming={!online || running || !!command} />
    </footer>}
  </section>;
}
