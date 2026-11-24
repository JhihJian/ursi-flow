"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PiPageHeader, PiPageHeading } from "@/components/PiPageHeader";
import { useI18n } from "@/hooks/useI18n";
import { usePiAccess, usePiSessionStream } from "@/hooks/usePiSession";
import { piHref, readPageId } from "@/lib/pi-page-links";
import { LivePrompt, usePromptCommands } from "./index";

export default function PromptPage() {
  const sessionId = readPageId(useSearchParams(), "session");
  const { canWrite, error } = usePiAccess();
  const { t } = useI18n();
  return (
    <>
      <PiPageHeader page="prompt" sessionId={sessionId} canWrite={canWrite} />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-4xl">
          <PiPageHeading title={t("pages.prompt")} sessionId={sessionId} />
          {error ? <p role="alert" className="mt-4 text-warning">{error}</p> :
            sessionId && canWrite === true ? <PromptSession key={sessionId} sessionId={sessionId} /> :
            <p role="status" className="mt-4 text-text-muted">{t(sessionId === "" ? "pages.invalidLink" : !sessionId ? "pages.selectSession" : canWrite === false ? "live.readOnly" : "pages.loading")}</p>}
        </div>
      </main>
    </>
  );
}

function PromptSession({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const { connected, snapshot, error } = usePiSessionStream(sessionId);
  const running = snapshot?.status === "running";
  const commands = usePromptCommands({ sessionId, enabled: true, connected, running });
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="mb-3 flex flex-wrap justify-between gap-2 text-sm">
        <p role="status" className={running && connected ? "text-accent" : "text-text-muted"}>
          {error ? null : t(!snapshot ? "pages.loading" : !connected ? "live.reconnecting" : `pages.status.${snapshot.status}`)}
        </p>
        <Link href={piHref("conversation", sessionId)} className="text-accent hover:underline">{t("pages.openConversation")}</Link>
      </div>
      {(error || commands.error) && <p role="alert" className="mb-3 text-warning">{error || commands.error}</p>}
      {snapshot && <LivePrompt commands={commands} sessionId={sessionId} messages={snapshot.messages} running={running} />}
    </div>
  );
}
