import { randomUUID } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CURRENT_SESSION_VERSION, parseSessionEntries, SessionManager } from '@earendil-works/pi-coding-agent';

export const sessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const historyLimit = 100;
const publicRoles = new Set(['user', 'assistant', 'toolResult']);
const isPublicEntry = entry => entry?.type === 'message' && publicRoles.has(entry.message?.role);

function publicHistory(entries, leafId) {
  const nearest = new Map();
  const nodes = new Map();
  // The SDK appends each entry after its parent, including when it copies a branch.
  for (const entry of entries) {
    const parentId = nearest.get(entry.parentId) ?? null;
    if (isPublicEntry(entry)) {
      nodes.set(entry.id, { entry, parentId });
      nearest.set(entry.id, entry.id);
    } else nearest.set(entry.id, parentId);
  }
  return { nodes, activeLeafId: nearest.get(leafId) ?? null };
}

export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createSessions({ root, cwd, openPi, apiKey, runtimeInfo, effectiveRuntime, maxRuns = 4 }) {
  const records = new Map();
  const running = new Map();
  const forking = new Set();
  const watchers = new Map();
  const updates = new Map();
  const publicText = (value, limit = 12_000) => typeof value === 'string'
    ? value.replaceAll(apiKey, '[redacted]').slice(0, limit) : '';
  const blocks = content => typeof content === 'string' ? [{ type: 'text', text: publicText(content) }]
    : Array.isArray(content) ? content.slice(0, 32).flatMap(block => {
      if (block?.type === 'text') return [{ type: 'text', text: publicText(block.text) }];
      if (block?.type === 'toolCall') return [{ type: 'toolCall', toolCallId: publicText(block.id, 256), toolName: publicText(block.name, 128), input: {} }];
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
      if (!raw.length) return [];
      const [header, ...entries] = parseSessionEntries(raw);
      if (header?.type !== 'session' || header.id !== meta.id || header.version !== CURRENT_SESSION_VERSION) {
        throw new Error('Invalid private session history');
      }
      return entries.filter(Boolean);
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
  async function readSession(id, project) {
    for (;;) {
      const meta = requireSession(id);
      const job = running.get(id);
      const manager = job?.manager;
      const entries = manager ? null : await load(meta);
      // A run can start or finish during the cold read. Use one history/status boundary.
      if (meta !== records.get(id) || job !== running.get(id) || manager !== job?.manager) continue;
      // On reload the SDK uses the final stored entry as its active leaf.
      const leafId = manager ? manager.getLeafId() : entries.at(-1)?.id ?? null;
      return project(meta, job, manager, entries, leafId);
    }
  }
  function requireEntry(present) {
    if (!present) throw new RequestError(404, '消息不存在');
  }
  function snapshot(id, entryId) {
    return readSession(id, (meta, job, manager, entries, leafId) => {
      const index = manager ? null : new Map(entries.map(entry => [entry.id, entry]));
      const lookup = id => manager ? manager.getEntry(id) : index.get(id);
      if (entryId !== undefined) requireEntry(isPublicEntry(lookup(entryId)));
      const messages = [];
      const entryIds = [];
      for (let entry = lookup(entryId ?? leafId); entry && messages.length < historyLimit; entry = lookup(entry.parentId)) {
        if (!isPublicEntry(entry)) continue;
        messages.push(message(entry.message));
        entryIds.push(entry.id);
      }
      const info = summary(meta);
      const live = entryId === undefined && info.status === 'running' ? job : null;
      return {
        ...info, messages: messages.reverse(), entryIds: entryIds.reverse(),
        partial: live?.partial ?? null, activeTool: live?.activeTool ?? null,
      };
    });
  }
  function structure(id) {
    return readSession(id, (meta, _job, manager, entries, leafId) => {
      const { nodes, activeLeafId } = publicHistory(manager ? manager.getEntries() : entries, leafId);
      return {
        activeLeafId,
        nodes: [...nodes.values()].map(({ entry, parentId }) => ({
          id: entry.id, parentId, role: entry.message.role,
          text: blocks(entry.message.content).filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 12_000),
        })),
        forkedFrom: meta.forkedFrom ?? null,
        forks: [...records.values()].filter(child => child.forkedFrom?.sessionId === id).map(child => ({
          sessionId: child.id, entryId: child.forkedFrom.entryId, title: child.title,
        })),
      };
    });
  }
  async function save(meta, { fresh = false } = {}) {
    const file = join(root, `${meta.id}.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(meta), { mode: 0o600, flag: 'wx' });
      if (fresh) await link(temp, file);
      else await rename(temp, file);
      records.set(meta.id, meta);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
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
      const file = join(root, meta.file);
      const info = await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const manager = info?.size ? SessionManager.open(file, root, cwd)
        : SessionManager.create(cwd, root, { id: meta.id });
      if (manager.getSessionId() !== meta.id) throw new Error('Private session ID mismatch');
      job.manager = manager;
      job.pi = await openPi(manager);
      const actual = basename(manager.getSessionFile());
      await save({ ...meta, file: actual, status: 'running' });
      unsubscribe = job.pi.subscribe(event => {
        if (event.type === 'message_update' && event.message.role === 'assistant') job.partial = message(event.message);
        // The SDK appends message_end to the manager after notifying listeners.
        // Snapshots read the manager, not the event, so they only expose assigned IDs.
        if (event.type === 'message_end' && event.message.role === 'assistant') job.partial = null;
        if (event.type === 'tool_execution_start') job.activeTool = publicText(event.toolName, 128);
        if (event.type === 'tool_execution_end') job.activeTool = null;
        update(meta.id);
      });
      if (!job.cancelled) await job.pi.prompt(instruction, {
        expandPromptTemplates: false,
        preflightResult(result) {
          if (result !== 'started') return;
          job.started = true;
          if (job.cancelled) void job.pi.abort().catch(() => {});
        },
      });
      const last = job.pi.messages.at(-1);
      status = job.cancelled ? 'cancelled' : last?.role === 'assistant' && last.stopReason === 'stop' ? 'completed' : 'failed';
    } catch {
      if (job.cancelled) status = 'cancelled';
    } finally {
      job.finishing = true;
      try {
        let runtime;
        try {
          unsubscribe?.();
          if (job.started) runtime = effectiveRuntime(job.pi);
        } finally {
          try { job.pi?.dispose(); }
          finally {
            await save({ ...requireSession(meta.id), ...(runtime && { runtime }), status, updatedAt: Date.now() });
          }
        }
      } finally { running.delete(meta.id); update(meta.id); }
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
        if (meta.forkedFrom !== undefined && (!meta.forkedFrom || !sessionId.test(meta.forkedFrom.sessionId) ||
            meta.forkedFrom.sessionId === id || typeof meta.forkedFrom.entryId !== 'string' || !meta.forkedFrom.entryId)) {
          throw new Error('Invalid private session fork metadata');
        }
        records.set(id, meta);
      }
      for (const meta of records.values()) {
        if (meta.forkedFrom && !records.has(meta.forkedFrom.sessionId)) throw new Error('Missing private fork source');
      }
    },
    list() { return [...records.values()].map(summary).sort((a, b) => b.updatedAt - a.updatedAt); },
    snapshot,
    structure,
    runtime(id) {
      const meta = requireSession(id);
      const job = running.get(id);
      return job?.started && !job.finishing ? effectiveRuntime(job.pi) : meta.runtime ?? runtimeInfo;
    },
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
      await save(meta, { fresh: true });
      return summary(meta);
    },
    async fork(id, entryId) {
      const source = requireSession(id);
      if (running.has(id) || forking.has(id)) throw new RequestError(409, '会话正在运行或分叉');
      forking.add(id);
      let staging;
      try {
        const entries = await load(source);
        requireEntry(entries.some(entry => entry?.id === entryId && isPublicEntry(entry)));
        staging = await mkdtemp(join(root, '.fork-'));
        // Branching changes the manager's file and ID. Keep it independent of the source.
        const manager = SessionManager.open(join(root, source.file), staging, cwd);
        const forkFile = manager.createBranchedSession(entryId);
        const childId = manager.getSessionId();
        if (!forkFile || !sessionId.test(childId) || records.has(childId)) throw new Error('Invalid fork session ID');
        try { await chmod(forkFile, 0o600); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // SDK can defer persistence if the path has only tool results.
          const journal = [manager.getHeader(), ...manager.getEntries()].map(entry => `${JSON.stringify(entry)}\n`).join('');
          await writeFile(forkFile, journal, { mode: 0o600, flag: 'wx' });
        }
        const file = basename(forkFile);
        const target = join(root, file);
        const meta = { id: childId, title: source.title, updatedAt: Date.now(), status: 'idle', file,
          forkedFrom: { sessionId: id, entryId } };
        // Publish the journal first, without replacing any existing file. Readers
        // discover it through the new metadata only after both files are in place.
        await link(forkFile, target);
        try { await save(meta, { fresh: true }); }
        catch (error) { await rm(target, { force: true }); throw error; }
        update(id);
        return summary(meta);
      } finally {
        if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
        forking.delete(id);
      }
    },
    async prompt(id, instruction) {
      const meta = requireSession(id);
      if (running.has(id)) throw new RequestError(409, '会话正在运行');
      if (forking.has(id)) throw new RequestError(409, '会话正在分叉');
      if (running.size >= maxRuns) throw new RequestError(429, '执行服务繁忙');
      const job = { manager: null, partial: null, activeTool: null, cancelled: false };
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
      if (!job || job.finishing) return false;
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
