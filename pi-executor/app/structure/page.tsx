"use client";

import { useSearchParams } from "next/navigation";
import { PiPageHeader, PiPageHeading } from "@/components/PiPageHeader";
import { usePiAccess, usePiSessionStream } from "@/hooks/usePiSession";
import { useI18n } from "@/hooks/useI18n";
import { readPageId } from "@/lib/pi-page-links";
import { LiveSessionStructure } from "./index";

export default function StructurePage() {
  const query = useSearchParams();
  const sessionId = readPageId(query, "session");
  const entryId = readPageId(query, "entry");
  const { canWrite } = usePiAccess();
  const { t } = useI18n();
  return (
    <>
      <PiPageHeader page="structure" sessionId={sessionId} canWrite={canWrite} />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-4xl">
          <PiPageHeading title={t("pages.structure")} sessionId={sessionId} />
          <div className="mt-4 border-t border-border pt-3">
            {sessionId && entryId !== "" ? <Structure key={sessionId} sessionId={sessionId} entryId={entryId} canWrite={canWrite === true} /> :
              <p role="status" className="text-text-muted">{t(sessionId === "" || entryId === "" ? "pages.invalidLink" : "pages.selectSession")}</p>}
          </div>
        </div>
      </main>
    </>
  );
}

function Structure({ sessionId, canWrite, entryId }: { sessionId: string; canWrite: boolean; entryId: string | null }) {
  const { connected, snapshot } = usePiSessionStream(sessionId);
  return <LiveSessionStructure sessionId={sessionId} entryId={entryId} canWrite={canWrite && connected} running={snapshot?.status === "running"} />;
}
