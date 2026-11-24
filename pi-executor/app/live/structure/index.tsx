"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ApiError, json, sessionPath, type Summary } from "../api";
import { messages, type StructureMessages } from "./messages";

export interface LiveSessionStructureProps {
  sessionId: string;
  canWrite: boolean;
  running: boolean;
  previewEntryId: string | null;
  onPreview: (entryId: string | null) => void;
  onOpenSession: (sessionId: string) => void;
  onForked: (summary: Summary) => void;
}

type MessagePoint = { id: string; parentId: string | null; role: string; text: string };
type ForkOrigin = { sessionId: string; entryId: string };
type Structure = {
  activeLeafId: string | null;
  nodes: MessagePoint[];
  forkedFrom: ForkOrigin | null;
  forks: (ForkOrigin & { title: string })[];
};

function indexNodes(nodes: MessagePoint[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map<string | null, MessagePoint[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node);
    else children.set(node.parentId, [node]);
  }
  return { byId, children, tips: nodes.filter(node => !children.has(node.id)) };
}

function trajectory(byId: Map<string, MessagePoint>, endId: string | null) {
  const path: MessagePoint[] = [];
  const seen = new Set<string>();
  for (let id = endId; id !== null && !seen.has(id);) {
    const node = byId.get(id);
    if (!node) break;
    path.push(node);
    seen.add(id);
    id = node.parentId;
  }
  return path.reverse();
}

function pointLabel(node: MessagePoint, copy: StructureMessages) {
  const role = node.role === "user" || node.role === "assistant" || node.role === "toolResult" ? copy[node.role] : node.role;
  const text = node.text.trim().replace(/\s+/g, " ");
  const excerpt = text.length > 96 ? `${text.slice(0, 96).trimEnd()}…` : text;
  return { role, excerpt: excerpt || copy.noText };
}

const button = "cursor-pointer rounded border border-border px-2 py-1 hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";
const linkButton = "cursor-pointer rounded text-left text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent";

export function LiveSessionStructure(props: LiveSessionStructureProps) {
  return <SessionStructurePanel key={props.sessionId} {...props} />;
}

function SessionStructurePanel({ sessionId, canWrite, running, previewEntryId, onPreview, onOpenSession, onForked }: LiveSessionStructureProps) {
  const { locale } = useI18n();
  const copy = messages[locale];
  const path = sessionPath(sessionId);
  const [load, setLoad] = useState<{ data: Structure | null; failed: boolean }>({ data: null, failed: false });
  const [reload, setReload] = useState(0);
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<"forkError" | "forkConflict" | null>(null);
  const command = useRef<AbortController | null>(null);
  const timeline = useRef<HTMLOListElement>(null);
  const refresh = () => setReload(previous => previous + 1);

  useEffect(() => {
    const controller = new AbortController();
    void json<Structure>(`${path}/structure`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setLoad({ data, failed: false });
    }, () => {
      if (!controller.signal.aborted) setLoad(previous => ({ ...previous, failed: true }));
    });
    return () => controller.abort();
  }, [path, reload, running]);

  useEffect(() => () => command.current?.abort(), []);

  const data = load.data;
  const parent = data?.forkedFrom;
  const { byId, children, tips } = useMemo(() => indexNodes(data?.nodes ?? []), [data]);
  const selectedId = previewEntryId !== null && byId.has(previewEntryId) ? previewEntryId : null;
  const activeId = data?.activeLeafId ?? null;
  const endId = selectedId ?? activeId;
  const route = useMemo(() => trajectory(byId, endId), [byId, endId]);
  const nextPoints = children.get(endId) ?? [];
  const tipValue = endId !== null && tips.some(node => node.id === endId) ? endId : "";
  const isPreviewing = previewEntryId !== null;

  useEffect(() => {
    const list = timeline.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [endId]);

  function selectPoint(entryId: string | null) {
    setForkError(null);
    onPreview(entryId);
  }

  async function fork() {
    if (!canWrite || running || selectedId === null || command.current) return;
    const controller = new AbortController();
    command.current = controller;
    setForking(true);
    setForkError(null);
    let summary: Summary;
    try {
      summary = await json<Summary>(`${path}/fork`, {
        method: "POST", body: JSON.stringify({ entryId: selectedId }), signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const conflict = error instanceof ApiError && error.status === 409;
      setForkError(conflict ? "forkConflict" : "forkError");
      if (conflict) refresh();
      return;
    } finally {
      if (!controller.signal.aborted) {
        command.current = null;
        setForking(false);
      }
    }
    if (controller.signal.aborted) return;
    refresh();
    onForked(summary);
  }

  function pointButton(node: MessagePoint) {
    const { role, excerpt } = pointLabel(node, copy);
    const live = node.id === activeId;
    const selected = node.id === selectedId;
    return (
      <button type="button" aria-pressed={selected} onClick={() => selectPoint(node.id)}
        className={`flex w-full min-w-0 cursor-pointer flex-wrap items-baseline gap-x-2 rounded px-2 py-1 text-left hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-accent ${selected ? "bg-bg-selected" : ""}`}>
        <span className="font-medium">{role}</span>
        <span className="min-w-0 flex-1 truncate text-text-muted" title={excerpt}>{excerpt}</span>
        {live && <span className="text-accent">{copy.livePoint}</span>}
        {selected && <span className="text-accent">{copy.preview}</span>}
      </button>
    );
  }

  return (
    <section aria-label={copy.title} className="grid min-w-0 grid-cols-1 gap-3 border-b border-border bg-bg-panel px-4 py-3 text-xs text-text">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">{copy.title}</h2>
        {isPreviewing && <button type="button" className={linkButton} onClick={() => selectPoint(null)}>{copy.returnLive}</button>}
      </header>

      {load.failed ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert">{copy.loadError}</p>
          <button type="button" onClick={refresh} className={button}>{copy.retry}</button>
        </div>
      ) : !data && <p role="status" className="text-text-muted">{copy.loading}</p>}

      {data && <>
        {(parent || data.forks.length > 0) && (
          <dl className="grid grid-cols-1 gap-2 border-b border-border pb-2">
            {parent && <div>
              <dt className="font-medium">{copy.parentSession}</dt>
              <dd><button type="button" className={`${linkButton} wrap-anywhere`} onClick={() => onOpenSession(parent.sessionId)}>{parent.sessionId}</button></dd>
            </div>}
            {data.forks.length > 0 && <div>
              <dt className="font-medium">{copy.childSessions}</dt>
              <dd><ul className="max-h-28 overflow-y-auto">
                {data.forks.map(child => <li key={child.sessionId}>
                  <button type="button" className={`${linkButton} max-w-full truncate`} title={child.title || copy.untitledSession} onClick={() => onOpenSession(child.sessionId)}>{child.title || copy.untitledSession}</button>
                </li>)}
              </ul></dd>
            </div>}
          </dl>
        )}

        <div className="grid grid-cols-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">{copy.trajectory}</h3>
            {tips.length > 1 && (
              <select aria-label={copy.branchTips} className="min-w-0 max-w-full rounded border border-border bg-bg px-1.5 py-1 focus-visible:outline-2 focus-visible:outline-accent sm:max-w-64" value={tipValue}
                onChange={event => selectPoint(event.target.value)}>
                <option value="" disabled>{copy.chooseTip}</option>
                {tips.map((node, index) => {
                  const { role, excerpt } = pointLabel(node, copy);
                  return <option key={node.id} value={node.id}>{index + 1}. {role}: {excerpt}{node.id === activeId ? ` (${copy.livePoint})` : ""}</option>;
                })}
              </select>
            )}
          </div>
          {isPreviewing && selectedId === null && <p role="status" className="text-text-muted">{copy.missingPreview}</p>}
          {data.nodes.length === 0 && <p className="text-text-muted">{copy.empty}</p>}
          {route.length > 0 && (
            <ol ref={timeline} aria-label={copy.trajectory} className="max-h-52 overflow-y-auto">
              {route.map(node => <li key={node.id} className="ml-1 border-l border-border pl-2">{pointButton(node)}</li>)}
            </ol>
          )}
          {nextPoints.length > 0 && <div className="mt-1">
            <h4 className="text-text-muted">{copy.nextMessages}</h4>
            <ul className="max-h-28 overflow-y-auto">
              {nextPoints.map(node => <li key={node.id}>{pointButton(node)}</li>)}
            </ul>
          </div>}
        </div>
      </>}

      {data && canWrite && !running && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <button type="button" className={button} onClick={() => void fork()} disabled={selectedId === null || forking}>{forking ? copy.forking : copy.fork}</button>
          {forkError && <p role="alert">{copy[forkError]}</p>}
        </footer>
      )}
    </section>
  );
}
