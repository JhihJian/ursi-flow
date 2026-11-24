"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PiPageHeader, PiPageHeading } from "@/components/PiPageHeader";
import { useI18n } from "@/hooks/useI18n";
import { usePiAccess } from "@/hooks/usePiSession";
import { piHref, readPageId } from "@/lib/pi-page-links";
import { LiveRuntimePanel, LiveRuntimeSettings } from "./index";
import { useRuntimeInfo } from "./useRuntimeInfo";

export default function RuntimePage() {
  const sessionId = readPageId(useSearchParams(), "session");
  const { canWrite } = usePiAccess();
  const { t } = useI18n();
  const { runtime, error } = useRuntimeInfo(sessionId);
  return (
    <>
      <PiPageHeader page="runtime" sessionId={sessionId} canWrite={canWrite} />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <PiPageHeading title={t("pages.runtime")} sessionId={sessionId} />
          {sessionId === "" ? <p role="status" className="mt-4 text-text-muted">{t("pages.invalidLink")}</p> :
            error ? <p role="alert" className="mt-4 text-warning">{error}</p> :
            !runtime ? <p role="status" className="mt-4 text-text-muted">{t("live.runtimeLoading")}</p> : (
              <>
                <div className="mt-3 flex flex-wrap justify-between gap-3 border-b border-border pb-3 text-sm">
                  <span className="text-text-muted">{t(runtime.scope === "session" ? "live.sessionRuntimeInfo" : "live.runtimeInfo")}</span>
                  {sessionId && <Link className="text-accent hover:underline" href={piHref("runtime")}>{t("pages.openServiceDefaults")}</Link>}
                </div>
                <div className="grid gap-x-8 gap-y-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <div className="min-w-0 space-y-5">
                    {(["models", "skills", "mcp"] as const).map(kind => <LiveRuntimeSettings key={kind} kind={kind} runtime={runtime} />)}
                  </div>
                  <div className="min-w-0 space-y-5">
                    <LiveRuntimePanel kind="system" runtime={runtime} />
                    <LiveRuntimePanel kind="tools" runtime={runtime} />
                  </div>
                </div>
              </>
            )}
        </div>
      </main>
    </>
  );
}
