import type { AgentMessage } from "@/lib/types";
import type { ToolEntry } from "@/lib/tool-presets";

export const statuses = {
  idle: "待开始", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已停止", interrupted: "已中断",
};

export type Summary = { id: string; title: string; updatedAt: number; status: keyof typeof statuses };
export type Snapshot = Summary & { messages: AgentMessage[]; partial: AgentMessage | null; activeTool: string | null };

export type RuntimeInfo = {
  systemPrompt: string;
  model: { id: string; name: string; provider: string };
  tools: ToolEntry[];
  skills: { name: string; description: string }[];
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function sessionPath(id: string) { return `/sessions/${encodeURIComponent(id)}`; }

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Pi-Web", "1");
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/pi${path}`, {
    ...init, headers, cache: "no-store", mode: "same-origin", redirect: "error", referrerPolicy: "origin",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(response.status, data?.error ?? `请求失败（${response.status}）`);
  }
  return response;
}

export async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request(path, init)).json();
}

export async function observe(id: string, signal: AbortSignal, receive: (snapshot: Snapshot) => void) {
  const response = await request(`${sessionPath(id)}/events`, { signal });
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("事件流不可用");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      // The session service sends single-line JSON frames and comment heartbeats.
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) receive(JSON.parse(frame.slice(6)));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
