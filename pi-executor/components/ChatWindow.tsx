"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { ConversationView, type ConversationViewProps } from "@/app/live/conversation/ConversationView";
import { useLiveConversation } from "@/app/live/conversation/useLiveConversation";
import { LivePrompt, usePromptCommands } from "@/app/live/prompt";
import type { LiveWorkspace } from "@/app/live/workspace";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";

type Props = Pick<ConversationViewProps, "searchTarget" | "onSearchTargetHandled" | "initialScrollPosition" | "onScrollPositionChange" | "onOpenFile" | "onOpenSession"> & {
  live?: LiveWorkspace;
  session: SessionInfo | null;
  previewEntryId?: string | null;
  chatInputRef?: RefObject<ChatInputHandle | null>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  unlockAudio?: () => void;
  // AppShell still supplies these legacy props. They do not drive live chat.
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  onAgentEnd?: () => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onAskInNewChat?: (prompt: string, sourceSessionId: string, sourceEntryId: string) => Promise<void>;
  quoteSelectionEnabled?: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
  playDoneSound?: () => void;
};

export function ChatWindow(props: Props) {
  return props.live && props.session
    ? <LiveChatWindow key={props.session.id} {...props} live={props.live} session={props.session} />
    : null;
}

function LiveChatWindow({
  live, session, previewEntryId = null, chatInputRef, soundEnabled, onSoundToggle, unlockAudio,
  searchTarget, onSearchTargetHandled, initialScrollPosition, onScrollPositionChange, onOpenFile, onOpenSession,
}: Props & { live: LiveWorkspace; session: SessionInfo }) {
  const { model, connected } = useLiveConversation(session.id, previewEntryId);
  const previewing = previewEntryId !== null;
  const canPrompt = live.canWrite === true && !previewing;
  const [scrollToLatestRequest, setScrollToLatestRequest] = useState(0);
  const followPrompt = useCallback(() => setScrollToLatestRequest(current => current + 1), []);
  const commands = usePromptCommands({
    sessionId: session.id, enabled: canPrompt, connected, running: model.running, chatInputRef, onPromptStart: followPrompt,
  });
  const liveScrollPosition = useRef(initialScrollPosition);
  const saveLiveScroll = useCallback<NonNullable<ConversationViewProps["onScrollPositionChange"]>>((id, position) => {
    liveScrollPosition.current = position;
    onScrollPositionChange?.(id, position);
  }, [onScrollPositionChange]);
  const displayModel = !previewing && commands.error
    ? { ...model, notices: [{ id: "command", type: "error" as const, message: commands.error }, ...model.notices] }
    : model;

  return (
    <ConversationView
      key={previewing ? `preview:${previewEntryId}` : "live"}
      model={displayModel}
      sessionId={session.id}
      messageCwd={session.cwd}
      searchTarget={previewing ? null : searchTarget}
      onSearchTargetHandled={onSearchTargetHandled}
      initialScrollPosition={previewing ? null : liveScrollPosition.current}
      onScrollPositionChange={previewing ? undefined : saveLiveScroll}
      onOpenFile={onOpenFile}
      onOpenSession={onOpenSession}
      scrollToLatestRequest={scrollToLatestRequest}
      footer={canPrompt ? <LivePrompt commands={commands} sessionId={session.id} messages={model.messages} running={model.running} soundEnabled={soundEnabled} onSoundToggle={onSoundToggle} unlockAudio={unlockAudio} /> : null}
    />
  );
}
