"use client";

import Link from "next/link";
import { useI18n } from "@/hooks/useI18n";
import { piHref, type PiPage } from "@/lib/pi-page-links";

const links = ["conversation", "prompt", "runtime", "structure"] as const;

export function PiPageHeader({ page, sessionId, canWrite }: { page?: PiPage; sessionId?: string | null; canWrite?: boolean | null }) {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  return (
    <header className="shrink-0 border-b border-border bg-bg-panel px-4 pt-[env(safe-area-inset-top)] sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5 text-xs">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-sm font-semibold text-text hover:text-accent">Pi Web</Link>
          <Link href="/" className="text-text-muted hover:text-accent" aria-current={!page ? "page" : undefined}>{t("pages.sessions")}</Link>
        </div>
        <div className="flex items-center gap-3">
          {canWrite === false && <span className="text-text-muted">{t("live.readOnly")}</span>}
          <select aria-label={t("common.language")} value={locale} onChange={event => {
            const next = supportedLocales.find(plugin => plugin.id === event.target.value);
            if (next) setLocale(next.id);
          }} className="max-w-28 rounded border border-border bg-bg px-1.5 py-0.5 text-text-muted">
            {supportedLocales.map(plugin => <option key={plugin.id} value={plugin.id}>{plugin.label}</option>)}
          </select>
        </div>
      </div>
      {sessionId && (
        <nav aria-label={t("pages.sessionViews")} className="mx-auto flex max-w-6xl flex-wrap gap-x-4 text-sm">
          {links.filter(name => name !== "prompt" || canWrite === true || page === "prompt").map(name => (
            <Link key={name} href={piHref(name, sessionId)} aria-current={page === name ? "page" : undefined}
              className={`border-b-2 py-2 ${page === name ? "border-accent text-text" : "border-transparent text-text-muted hover:text-accent"}`}>
              {t(`pages.${name}`)}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

export function PiPageHeading({ title, sessionId }: { title: string; sessionId?: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h1 className="text-xl font-semibold">{title}</h1>
      {sessionId && <code className="text-xs wrap-anywhere text-text-muted">{sessionId}</code>}
    </div>
  );
}
