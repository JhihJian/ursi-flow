import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChatInput, getUserMessageText, type AttachedImage, type ChatInputHandle } from "@/components/ChatInput";
import { restoreDraftSubmission } from "@/lib/draft-store";
import type { AgentMessage } from "@/lib/types";
import { json, sessionPath } from "@/lib/pi-session-api";

type PromptCommandsOptions = {
  sessionId: string;
  enabled: boolean;
  connected: boolean;
  running: boolean;
};

// A request can resolve after the composer is hidden or its session is reopened.
const activeComposers = new Map<string, {
  input: RefObject<ChatInputHandle | null>;
  reportError: (message: string) => void;
}>();
const pendingPrompts = new Set<string>();
const pendingStops = new Set<string>();

export function usePromptCommands({ sessionId, enabled, connected, running }: PromptCommandsOptions) {
  const input = useRef<ChatInputHandle | null>(null);
  const attachInput = useCallback((handle: ChatInputHandle | null) => {
    input.current = handle;
  }, []);
  const [error, setError] = useState<string | null>(null);
  const availability = useRef({ send: false, stop: false });
  const canSend = enabled && connected && !running;
  const canStop = enabled && connected && running;

  useLayoutEffect(() => {
    const active = { input, reportError: setError };
    activeComposers.set(sessionId, active);
    return () => {
      if (activeComposers.get(sessionId) === active) activeComposers.delete(sessionId);
    };
  }, [sessionId]);
  useLayoutEffect(() => {
    // ChatInput can invoke a previously captured callback after yielding.
    availability.current = { send: canSend, stop: canStop };
    return () => { availability.current = { send: false, stop: false }; };
  }, [canSend, canStop]);

  const send = useCallback(async (message: string, images?: AttachedImage[]) => {
    const restore = () => {
      const draftImages = images?.map(({ data, mimeType }) => ({ data, mimeType }));
      const composer = activeComposers.get(sessionId)?.input.current;
      if (composer) composer.restoreSubmission(message, draftImages, sessionId);
      else restoreDraftSubmission(sessionId, message, draftImages);
    };
    if (!availability.current.send || pendingPrompts.has(sessionId) || pendingStops.has(sessionId) || !message.trim()) {
      restore();
      return;
    }

    pendingPrompts.add(sessionId);
    setError(null);
    try {
      // Command acknowledgements do not carry conversation state. The read
      // stream may already have delivered output or reported completion.
      await json(`${sessionPath(sessionId)}/prompt`, { method: "POST", body: JSON.stringify({ message }) });
    } catch (error) {
      activeComposers.get(sessionId)?.reportError(error instanceof Error ? error.message : String(error));
      restore();
    } finally {
      pendingPrompts.delete(sessionId);
    }
  }, [sessionId]);

  const stop = useCallback(async () => {
    if (!availability.current.stop || pendingStops.has(sessionId)) return;
    pendingStops.add(sessionId);
    setError(null);
    try {
      await json(`${sessionPath(sessionId)}/cancel`, { method: "POST" });
    } catch (error) {
      activeComposers.get(sessionId)?.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      pendingStops.delete(sessionId);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!canStop) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest("textarea, input, select, [contenteditable=true]")) return;
      event.preventDefault();
      void stop();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [canStop, stop]);

  return { attachInput, send, stop, error };
}

interface LivePromptProps {
  commands: ReturnType<typeof usePromptCommands>;
  sessionId: string;
  messages: AgentMessage[];
  running: boolean;
}

export function LivePrompt({ commands, sessionId, messages, running }: LivePromptProps) {
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    for (let i = messages.length - 1; i >= 0 && seen.size < 50; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      const text = getUserMessageText(message).trim();
      if (text) seen.add(text);
    }
    return Array.from(seen).reverse();
  }, [messages]);

  return (
    <ChatInput
      ref={commands.attachInput}
      textOnly
      onSend={commands.send}
      onAbort={commands.stop}
      isStreaming={running}
      inputHistory={inputHistory}
      draftKey={sessionId}
    />
  );
}
