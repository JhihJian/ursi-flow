import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SessionManager } from './pi.mjs';

export const sessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const historyLimit = 100;

export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createSessions({ root, cwd, openPi, apiKey, maxRuns = 4 }) {
  const records = new Map();
  const running = new Map();
  const watchers = new Map();
  const updates = new Map();
  const publicText = (value, limit = 12_000) => typeof value === 'string'
    ? value.replaceAll(apiKey, '[redacted]').slice(0, limit) : '';
  const blocks = content => typeof content === 'string' ? [{ type: 'text', text: publicText(content) }]
    : Array.isArray(content) ? content.slice(0, 32).flatMap(block => {
      if (block.type === 'text') return [{ type: 'text', text: publicText(block.text) }];
      if (block.type === 'toolCall') return [{ type: 'toolCall', toolCallId: publicText(block.id, 256), toolName: publicText(block.name, 128), input: {} }];
      return [];
    }) : [];
  function message(value) {
    if (value?.role === 'assistant') return {
      role: value.role, content: blocks(value.content), provider: publicText(value.provider, 100), model: publicText(value.model, 300),
      timestamp: value.timestamp, stopReason: value.stopReason,
    };
    if (value?.role === 'toolResult') return {
      role: value.role, content: blocks(value.content), toolCallId: publicText(value.toolCallId, 256),
      toolName: publicText(value.toolName, 128), isError: value.isError === true, timestamp: value.timestamp,
    };
    if (value?.role === 'user') return { role: 'user', content: blocks(value.content), timestamp: value.timestamp };
  }
  async function load(meta) {
    try {
      const raw = await readFile(join(root, meta.file), 'utf8');
      const entries = raw.trimEnd().split('\n');
      const messages = [];
      for (let i = entries.length - 1; i > 0 && messages.length < historyLimit; i--) {
        let entry;
        try { entry = JSON.parse(entries[i]); }
        catch (error) { if (i === entries.length - 1) continue; throw error; }
        const item = entry.type === 'message' && message(entry.message);
        if (item) messages.push(item);
      }
      return messages.reverse();
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function summary(meta) {
    const { id, title, updatedAt, status } = meta;
    return { id, title, updatedAt, status: status === 'running' && !running.has(id) ? 'interrupted' : status };
  }
  function requireSession(id) {
    const meta = records.get(id);
    if (!meta) throw new RequestError(404, '会话不存在');
    return meta;
  }
  async function snapshot(id) {
    for (;;) {
      const meta = requireSession(id);
      const active = running.get(id);
      const messages = active?.messages ?? await load(meta);
      // Keep status and history from the same run boundary after an async disk read.
      if (meta !== records.get(id) || active !== running.get(id)) continue;
      return {
        ...summary(meta), messages: active?.messages ?? messages,
        partial: active?.partial ?? null, activeTool: active?.activeTool ?? null,
      };
    }
  }
  async function save(meta) {
    const file = join(root, `${meta.id}.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(meta), { mode: 0o600 });
    await rename(temp, file);
    records.set(meta.id, meta);
  }
  function update(id) {
    if (!watchers.has(id) || updates.has(id)) return;
    updates.set(id, setTimeout(() => {
      updates.delete(id);
      for (const listener of watchers.get(id) ?? []) listener();
    }, 90));
  }
  async function execute(meta, job, instruction) {
    let status = 'failed';
    let unsubscribe;
    try {
      job.messages = await load(meta);
      const file = join(root, meta.file);
      const manager = job.messages.length ? SessionManager.open(file, root)
        : SessionManager.create(cwd, root, { id: meta.id });
      if (manager.getSessionId() !== meta.id) throw new Error('Private session ID mismatch');
      job.pi = await openPi(manager);
      const actual = basename(manager.getSessionFile());
      await save({ ...meta, file: actual, status: 'running' });
      unsubscribe = job.pi.subscribe(event => {
        if (event.type === 'message_update' && event.message.role === 'assistant') job.partial = message(event.message);
        if (event.type === 'message_end') {
          const item = message(event.message);
          if (event.message.role === 'assistant') job.partial = null;
          if (item) job.messages = [...job.messages, item].slice(-historyLimit);
        }
        if (event.type === 'tool_execution_start') job.activeTool = publicText(event.toolName, 128);
        if (event.type === 'tool_execution_end') job.activeTool = null;
        update(meta.id);
      });
      if (!job.cancelled) await job.pi.prompt(instruction, {
        expandPromptTemplates: false,
        preflightResult(result) {
          if (result === 'started' && job.cancelled) void job.pi.abort().catch(() => {});
        },
      });
      const last = job.pi.messages.at(-1);
      status = job.cancelled ? 'cancelled' : last?.role === 'assistant' && last.stopReason === 'stop' ? 'completed' : 'failed';
    } catch {
      if (job.cancelled) status = 'cancelled';
    } finally {
      unsubscribe?.();
      job.pi?.dispose();
      try { await save({ ...requireSession(meta.id), status, updatedAt: Date.now() }); }
      finally { running.delete(meta.id); update(meta.id); }
    }
  }
  return {
    async restore() {
      for (const name of await readdir(root)) {
        const id = name.slice(0, -5);
        if (!name.endsWith('.json') || !sessionId.test(id)) continue;
        const meta = JSON.parse(await readFile(join(root, name), 'utf8'));
        if (meta.id !== id || typeof meta.file !== 'string' || basename(meta.file) !== meta.file || !meta.file.endsWith(`${id}.jsonl`)) {
          throw new Error('Invalid private session metadata');
        }
        records.set(id, meta);
      }
    },
    list() { return [...records.values()].map(summary).sort((a, b) => b.updatedAt - a.updatedAt); },
    snapshot,
    subscribe(id, notify) {
      requireSession(id);
      const group = watchers.get(id) ?? new Set();
      watchers.set(id, group);
      group.add(notify);
      return () => { group.delete(notify); if (group.size === 0) watchers.delete(id); };
    },
    async create(title) {
      const id = randomUUID();
      const meta = { id, title: publicText(title, 100), updatedAt: Date.now(), status: 'idle', file: `${id}.jsonl` };
      await save(meta);
      return summary(meta);
    },
    async prompt(id, instruction) {
      const meta = requireSession(id);
      if (running.has(id)) throw new RequestError(409, '会话正在运行');
      if (running.size >= maxRuns) throw new RequestError(429, '执行服务繁忙');
      const job = { messages: null, partial: null, activeTool: null, cancelled: false };
      running.set(id, job);
      const next = { ...meta, status: 'running', updatedAt: Date.now(), title: meta.title || publicText(instruction, 100) };
      try { await save(next); }
      catch (error) { running.delete(id); throw error; }
      job.done = execute(next, job, instruction).catch(() => {});
      update(id);
      return summary(next);
    },
    cancel(id) {
      requireSession(id);
      const job = running.get(id);
      if (!job) return false;
      job.cancelled = true;
      void job.pi?.abort().catch(() => {});
      return true;
    },
    async stop() {
      const jobs = [...running.values()];
      for (const job of jobs) {
        job.cancelled = true;
        void job.pi?.abort().catch(() => {});
      }
      await Promise.all(jobs.map(job => job.done));
    },
  };
}
