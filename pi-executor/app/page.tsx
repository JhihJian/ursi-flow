"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PiPageHeader, PiPageHeading } from "@/components/PiPageHeader";
import { useI18n } from "@/hooks/useI18n";
import { usePiAccess } from "@/hooks/usePiSession";
import { json, type Summary } from "@/lib/pi-session-api";
import { piHref } from "@/lib/pi-page-links";

export default function SessionsPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { canWrite, error: accessError } = usePiAccess();
  const [sessions, setSessions] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const request = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const data = await json<{ sessions: Summary[] }>("/sessions", { signal });
        if (!signal.aborted) { setSessions(data.sessions); setError(null); }
      } catch (err) {
        if (!signal.aborted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal.aborted) timer = setTimeout(() => void refresh(), 3000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  async function create() {
    if (canWrite !== true || request.current) return;
    request.current = true;
    setCreating(true);
    setCommandError(null);
    try {
      const { id } = await json<Summary>("/sessions", { method: "POST", body: "{}" });
      router.push(piHref("prompt", id));
    } catch (err) {
      setCommandError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
      request.current = false;
    }
  }

  const search = filter.trim().toLocaleLowerCase();
  const visible = sessions?.filter(({ id, title }) => `${title || t("pages.untitled")} ${id}`.toLocaleLowerCase().includes(search));
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const links = canWrite === true ? ["prompt", "runtime", "structure"] as const : ["runtime", "structure"] as const;
  return (
    <>
      <PiPageHeader canWrite={canWrite} />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <PiPageHeading title={t("pages.sessions")} />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <input type="search" aria-label={t("pages.search")} placeholder={t("pages.search")} value={filter} onChange={event => setFilter(event.target.value)}
              className="min-w-0 rounded border border-border bg-bg-panel px-2.5 py-1.5 text-sm sm:w-64" />
            <div className="flex flex-wrap items-center gap-3">
              <Link href={piHref("runtime")} className="text-sm text-accent hover:underline">{t("live.runtimeInfo")}</Link>
              {canWrite === true && <button type="button" disabled={creating} onClick={() => void create()}
                className="cursor-pointer rounded border border-border bg-bg-panel px-3 py-1.5 text-sm text-accent hover:bg-bg-hover disabled:opacity-50">
                {t(creating ? "pages.creating" : "pages.newSession")}
              </button>}
            </div>
          </div>
          {(commandError || error || accessError) && <p role="alert" className="py-4 text-warning">{commandError || error || accessError}</p>}
          {!sessions && !error && <p role="status" className="py-4 text-text-muted">{t("pages.loading")}</p>}
          {visible?.length === 0 && <p className="py-6 text-text-muted">{t(search ? "pages.noMatches" : "pages.noSessions")}</p>}
          {visible && visible.length > 0 && (
            <ul className="divide-y divide-border">
              {visible.map(session => (
                <li key={session.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
                  <div className="min-w-0 flex-1 basis-60">
                    <Link href={piHref("conversation", session.id)} className="font-medium wrap-anywhere text-text hover:text-accent hover:underline">{session.title || t("pages.untitled")}</Link>
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-muted">
                      <span className={session.status === "running" ? "text-accent" : undefined}>{t(`pages.status.${session.status}`)}</span>
                      <time dateTime={new Date(session.updatedAt).toISOString()}>{dates.format(session.updatedAt)}</time>
                      <code className="wrap-anywhere">{session.id}</code>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {links.map(page => <Link href={piHref(page, session.id)} key={page} className="text-accent hover:underline">{t(`pages.${page}`)}</Link>)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
