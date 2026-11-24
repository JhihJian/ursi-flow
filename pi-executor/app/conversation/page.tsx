"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PiPageHeader, PiPageHeading } from "@/components/PiPageHeader";
import { useI18n } from "@/hooks/useI18n";
import { usePiAccess } from "@/hooks/usePiSession";
import { piHref, readPageId } from "@/lib/pi-page-links";
import { ConversationView } from "./ConversationView";
import { useLiveConversation } from "./useLiveConversation";

export default function ConversationPage() {
  const query = useSearchParams();
  const sessionId = readPageId(query, "session");
  const entryId = readPageId(query, "entry");
  const { canWrite } = usePiAccess();
  const { t } = useI18n();
  return (
    <>
      <PiPageHeader page="conversation" sessionId={sessionId} canWrite={canWrite} />
      <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
        <div className="shrink-0 border-b border-border px-4 py-4 sm:px-6">
          <PiPageHeading title={t("pages.conversation")} sessionId={sessionId} />
          {entryId && sessionId && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="text-text-muted">{t("live.historyPreview")}</span>
            <Link className="text-accent hover:underline" href={piHref("conversation", sessionId)}>{t("live.returnToLive")}</Link>
            <Link className="text-accent hover:underline" href={piHref("structure", sessionId, entryId)}>{t("pages.structure")}</Link>
          </div>}
        </div>
        {sessionId && entryId !== "" ? <Conversation key={`${sessionId}:${entryId ?? ""}`} sessionId={sessionId} entryId={entryId} /> :
          <p role="status" className="p-4 text-text-muted">{t(sessionId === "" || entryId === "" ? "pages.invalidLink" : "pages.selectSession")}</p>}
      </main>
    </>
  );
}

function Conversation({ sessionId, entryId }: { sessionId: string; entryId: string | null }) {
  const model = useLiveConversation(sessionId, entryId);
  const router = useRouter();
  return <div className="min-h-0 flex-1">
    <ConversationView model={model} sessionId={sessionId} onOpenSession={id => router.push(piHref("conversation", id))} />
  </div>;
}
