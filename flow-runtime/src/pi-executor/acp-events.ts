import { randomUUID } from 'node:crypto';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

export type Update = { sessionUpdate: string } & Record<string, unknown>;

// Keep a suffix only while it could be the start of a protected value. This lets
// ordinary deltas through without disclosing a credential split across SSE chunks.
function redactor(values: string[]) {
  const strip = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const literals = [...new Set(values.map(strip).filter(Boolean))].sort((a, b) => b.length - a.length);
  const heads = new Map<string, string[]>();
  for (const literal of literals) {
    const key = literal[0]!;
    const list = heads.get(key) ?? [];
    list.push(literal);
    heads.set(key, list);
  }
  let pending = '';
  return (delta: string, final = false) => {
    const text = pending + strip(delta);
    const output: string[] = [];
    pending = '';
    let start = 0;
    for (let i = 0; i < text.length;) {
      const candidates = heads.get(text[i]!);
      if (!candidates) { i++; continue; }
      const possible = candidates.find(v => v.length <= text.length - i ? text.startsWith(v, i) : v.startsWith(text.slice(i)));
      if (!possible) { i++; continue; }
      output.push(text.slice(start, i));
      if (possible.length > text.length - i) {
        if (final) output.push('[redacted]');
        else pending = text.slice(i);
        start = text.length;
        break;
      }
      output.push('[redacted]');
      start = i += possible.length;
    }
    output.push(text.slice(start));
    return output.join('');
  };
}

export function piUpdates(options: {
  emit: (update: Update) => void; inserted: () => void; protectedText: string[];
  names: string[]; signal: AbortSignal;
}) {
  const { emit, inserted, signal, names, protectedText } = options;
  const tools = new Map<string, string>();
  const allow = new Set(names);
  let messageId: string | undefined;
  let sanitize = redactor(protectedText);
  let deltaSeen = false;
  let bytes = 0, count = 0;
  function publicText(text: string, final = false) {
    if (++count > 4096 || (bytes += Buffer.byteLength(text)) > 1024 * 1024) return;
    const safe = sanitize(text, final);
    if (!safe || !messageId) return;
    emit({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: safe } });
  }
  return (event: AgentSessionEvent) => {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') {
          messageId = randomUUID();
          sanitize = redactor(protectedText);
          deltaSeen = false;
        }
        break;
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta' && !signal.aborted) {
          deltaSeen = true;
          publicText(event.assistantMessageEvent.delta);
        }
        break;
      case 'message_end':
        if (event.message.role === 'user') inserted();
        if (event.message.role === 'assistant' && !signal.aborted) {
          const last = event.message;
          publicText(deltaSeen ? '' : last.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), true);
        }
        break;
      case 'tool_execution_start': {
        const toolCallId = randomUUID();
        tools.set(event.toolCallId, toolCallId);
        emit({ sessionUpdate: 'tool_call_update', toolCallId,
          name: allow.has(event.toolName) ? event.toolName : 'unavailable', status: 'in_progress' });
        break;
      }
      case 'tool_execution_end': {
        const toolCallId = tools.get(event.toolCallId);
        if (!toolCallId) break;
        tools.delete(event.toolCallId);
        emit({ sessionUpdate: 'tool_call_update', toolCallId,
          status: event.isError ? signal.aborted ? 'cancelled' : 'failed' : 'completed' });
        break;
      }
    }
  };
}
