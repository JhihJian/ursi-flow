"use client";

import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";
import { useLiveWorkspace } from "./workspace";

export function LiveRoot() {
  return <I18nProvider><LiveWorkspaceView /></I18nProvider>;
}

function LiveWorkspaceView() {
  const workspace = useLiveWorkspace();
  return <AppShell live={workspace} />;
}
