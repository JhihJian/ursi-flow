#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { acpEnvironment, directory, layout } from './files.ts';
import { loadPolicy, record } from './policy.ts';
import { preparePi, type PiStop } from './session.ts';
import { piUpdates, type Update } from './acp-events.ts';

const FRAME_LIMIT = 4 * 1024 * 1024;
const TEXT_LIMIT = 256 * 1024;
const SESSION_LIMIT = 8;
const GENERIC_PROMPT_LIMIT = 16;
const defaults = "You are a managed Pi assistant. Respond to the user's task.";
const messages: Record<number, string> = {
  [-32700]: 'Parse error', [-32600]: 'Invalid request', [-32601]: 'Method not found',
  [-32602]: 'Invalid params', [-32603]: 'Pi operation failed', [-32800]: 'Request cancelled',
  [-32002]: 'Session not found', [-32022]: 'Unsupported protocol version', [-32001]: 'Managed session limit reached',
};
class Fault extends Error {
  readonly code: number;
  readonly data?: Record<string, unknown>;
  constructor(code: number, data?: Record<string, unknown>) {
    super(messages[code]);
    this.code = code;
    this.data = data;
  }
}
function invalid(): never { throw new Fault(-32602); }
const cancelled = () => new Fault(-32800);

type Id = string | number;
type Block = { type: 'text'; text: string } | { type: 'resource_link'; name: string; uri: string };
type SetupPrompt = { mode: 'append' | 'override'; text: string };
function path(v: unknown): string {
  if (typeof v !== 'string' || !isAbsolute(v) || v.includes('\0') || Buffer.byteLength(v) > 4096) invalid();
  return resolve(v);
}
function blockText(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 128 || value.some(b => !record(b) || b.type !== 'text' || typeof b.text !== 'string')) invalid();
  const text = value.map(b => b.text as string).join('\n\n');
  if (!text.trim() || Buffer.byteLength(text) > TEXT_LIMIT) invalid();
  return text;
}
function setup(params: Record<string, unknown>): SetupPrompt | undefined {
  if (params.mcpServers != null && (!Array.isArray(params.mcpServers) || params.mcpServers.length)) invalid();
  if (params.systemPrompt == null) return;
  const p = params.systemPrompt;
  if (!record(p) || (p.mode !== 'append' && p.mode !== 'override')) invalid();
  return { mode: p.mode, text: blockText(p.content) };
}
function promptBlocks(value: unknown): { blocks: Block[]; instruction: string } {
  if (!Array.isArray(value) || !value.length || value.length > 128) invalid();
  const blocks: Block[] = value.map(b => {
    if (!record(b)) invalid();
    if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
    if (b.type === 'resource_link' && typeof b.name === 'string' && typeof b.uri === 'string') {
      // Link metadata is user context, never authority to open a file or fetch a URL.
      return { type: 'resource_link', name: b.name, uri: b.uri };
    }
    return invalid();
  });
  const instruction = blocks.map(b => b.type === 'text' ? b.text : `Resource reference: ${JSON.stringify({ name: b.name, uri: b.uri })}`).join('\n\n');
  if (!instruction.trim() || Buffer.byteLength(instruction) > TEXT_LIMIT) invalid();
  return { blocks, instruction };
}

type Pi = Awaited<ReturnType<typeof preparePi>>;
type Ack = { messageId: string };
interface Turn {
  key?: string; blocks: Block[]; instruction: string; controller: AbortController;
  ack: Promise<Ack>; accept: (ack: Ack) => void; reject: (error: Fault) => void;
  inserted: boolean; committed: boolean; running: boolean;
}
interface Session {
  id: string; cwd: string; setupPrompt?: SetupPrompt; systemPrompt: string; binding: string;
  pi?: Pi; manager?: Pi['manager']; active: boolean; closing?: Promise<void>; reopening?: boolean;
  history: { update: Update; bytes: number }[]; historyBytes: number;
  recorded: Map<string, Ack>; inserted: number; queue: Turn[]; turn?: Turn; done?: Promise<void>;
}

class Agent {
  private initialized = false;
  private used = false;
  private opening = 0;
  private readonly abort = new AbortController();
  private readonly sessions = new Map<string, Session>();
  private readonly env: ReturnType<typeof acpEnvironment>;
  private readonly send: (value: object) => void;
  constructor(env: ReturnType<typeof acpEnvironment>, send: (value: object) => void) {
    this.env = env;
    this.send = send;
  }

  private emit(s: Session, update: Update, retain = true) {
    if (retain && update.sessionUpdate !== 'state_update' && update.sessionUpdate !== 'replay_complete') {
      const bytes = Buffer.byteLength(JSON.stringify(update));
      s.history.push({ update, bytes });
      s.historyBytes += bytes;
      while (s.history.length > 4096 || s.historyBytes > 2 * 1024 * 1024) s.historyBytes -= s.history.shift()!.bytes;
    }
    this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: s.id, update } });
  }

  private state(s: Session, stopReason?: PiStop) {
    this.emit(s, { sessionUpdate: 'state_update', state: s.turn?.running && !stopReason ? 'running' : 'idle', background: [],
      ...(stopReason ? { stopReason, ...(stopReason === 'error' ? { error: { code: -32603, message: messages[-32603] } } : {}) } : {}) });
  }

  private async assemble(s: Session, signal: AbortSignal) {
    const { job, policy } = this.env;
    const loaded = await loadPolicy(policy);
    const config = job?.config ?? { modelProfile: loaded.models[0]?.id ?? '', tools: [], skills: [] };
    if (this.binding(s.cwd) !== s.binding) invalid();
    return preparePi({ config: { ...config, systemPrompt: s.systemPrompt }, workspace: s.cwd, policyPath: policy, policy: loaded,
      nodeContract: job?.nodeContract, preflight: !job, manager: s.manager, signal: AbortSignal.any([signal, this.abort.signal]) });
  }

  private binding(cwd: string) {
    const { root, job } = this.env;
    if (!job) return directory(cwd);
    if (cwd !== job.cwd) invalid();
    return layout({ URSI_EXECUTOR_ROOT: root }, job.attemptId).binding;
  }

  private async open(params: Record<string, unknown>, signal: AbortSignal) {
    const cwd = path(params.cwd);
    const requested = setup(params);
    const { job } = this.env;
    if (job && (this.sessions.size || this.opening)) throw new Fault(-32001);
    if (this.sessions.size + this.opening >= SESSION_LIMIT) {
      const old = [...this.sessions.values()].find(s => !s.active && !s.closing && !s.reopening);
      if (!old) throw new Fault(-32001);
      this.sessions.delete(old.id);
    }
    const base = job?.config.systemPrompt ?? defaults;
    const binding = this.binding(cwd);
    if (job && binding !== job.binding) invalid();
    const systemPrompt = requested ? requested.mode === 'override' ? requested.text : `${base}\n\n${requested.text}` : base;
    if (Buffer.byteLength(systemPrompt) > TEXT_LIMIT) invalid();
    const s: Session = { id: randomUUID(), cwd, setupPrompt: requested, binding, systemPrompt,
      active: true, history: [], historyBytes: 0, recorded: new Map(), inserted: 0, queue: [] };
    this.opening++;
    try {
      s.pi = await this.assemble(s, signal);
      if (signal.aborted || this.abort.signal.aborted) { await s.pi.close(); throw cancelled(); }
      if (!job) s.manager = s.pi.manager;
      this.sessions.set(s.id, s);
      return { sessionId: s.id };
    } finally { this.opening--; }
  }

  private async resume(s: Session, params: Record<string, unknown>, signal: AbortSignal) {
    const requested = setup(params);
    const replay = params.replayFrom;
    if (path(params.cwd) !== s.cwd || (requested &&
      (requested.mode !== s.setupPrompt?.mode || requested.text !== s.setupPrompt?.text)) ||
      (replay != null && (!record(replay) || replay.type !== 'start'))) invalid();
    if (s.reopening || s.closing) throw new Fault(-32001);
    if (this.binding(s.cwd) !== s.binding) invalid();
    if (!s.active && (!this.env.job || !s.inserted)) {
      s.reopening = true;
      try {
        s.pi = await this.assemble(s, signal);
        if (signal.aborted || this.abort.signal.aborted) { await s.pi.close(); s.pi = undefined; throw cancelled(); }
      } finally { s.reopening = false; }
    }
    s.active = true;
    // Replay and state sync form one synchronous cut. Pi's live events cannot interleave.
    if (replay != null) {
      for (const { update } of s.history) this.emit(s, update, false);
      this.emit(s, { sessionUpdate: 'replay_complete' }, false);
    }
    this.state(s);
    return {};
  }

  private start(s: Session) {
    if (s.turn || s.closing || !s.queue.length) return;
    const turn = s.queue.shift()!;
    s.turn = turn;
    s.done = this.run(s, turn);
  }

  private async run(s: Session, turn: Turn) {
    // Keep reading stdin while a queued submission waits for the SDK. A cancel in
    // the same input batch can stop it before insertion, without a false ACK.
    await new Promise<void>(resolve => setImmediate(resolve));
    const signal = turn.controller.signal;
    let stop: PiStop = 'cancelled';
    try {
      if (!signal.aborted) {
        if (this.env.job && this.binding(s.cwd) !== s.binding) invalid();
        const pi = s.pi!;
        const protectedText = [...pi.secrets, s.cwd, this.env.root, this.env.policy, s.systemPrompt,
          ...(this.env.job ? [this.env.job.config.systemPrompt, ...this.env.job.config.skills.flatMap(skill => [
            skill.content, ...(skill.files ?? []).map(file => Buffer.from(file.contentBase64, 'base64').toString('utf8')),
          ])] : []),
        ].flatMap(v => [v, ...v.split('\n').filter(line => line.trim().length >= 12)]);
        turn.running = true;
        this.state(s);
        stop = await pi.run(turn.instruction, signal, piUpdates({ signal, names: pi.toolNames, protectedText,
          emit: update => this.emit(s, update),
          inserted: () => {
            if (turn.inserted) return;
            turn.inserted = true;
            s.inserted++;
            const ack = { messageId: randomUUID() };
            if (turn.key) s.recorded.set(turn.key, ack);
            this.emit(s, { sessionUpdate: 'user_message', ...ack, content: turn.blocks });
            turn.accept(ack);
          },
        }), () => { turn.committed = true; });
      }
    } catch { stop = signal.aborted && !turn.committed ? 'cancelled' : 'error'; }
    finally {
      if (!turn.inserted) turn.reject(stop === 'cancelled' ? cancelled() : new Fault(-32603));
      // Managed production keeps only replay data after its single insertion.
      if (this.env.job && turn.inserted) {
        try { await s.pi?.close(); } catch { stop = 'error'; }
        s.pi = undefined;
      }
      s.turn = undefined;
      s.done = undefined;
      if (turn.running) this.state(s, stop);
      this.start(s);
    }
  }

  private enqueue(s: Session, params: Record<string, unknown>, signal: AbortSignal): Promise<Ack> {
    const key = params.idempotencyKey ?? undefined;
    if (key !== undefined && (typeof key !== 'string' || !key.length || [...key].length > 255)) invalid();
    const { blocks, instruction } = promptBlocks(params.prompt);
    const recorded = key && s.recorded.get(key);
    if (recorded) return Promise.resolve(recorded);
    const pending = key && [s.turn, ...s.queue].find(t => t?.key === key && !t.controller.signal.aborted);
    if (pending) return this.watch(s, pending, signal);
    const reserved = s.queue.length + Number(!!s.turn && !s.turn.inserted && !s.turn.controller.signal.aborted);
    if (s.inserted + reserved >= (this.env.job ? 1 : GENERIC_PROMPT_LIMIT) || s.queue.length >= 8) throw new Fault(-32001);
    let accept!: Turn['accept'];
    let reject!: Turn['reject'];
    const ack = new Promise<Ack>((resolve, fail) => { accept = resolve; reject = fail; });
    const turn: Turn = { key, blocks, instruction, controller: new AbortController(), ack, accept, reject, inserted: false, committed: false, running: false };
    s.queue.push(turn);
    this.start(s);
    return this.watch(s, turn, signal);
  }

  private watch(s: Session, t: Turn, signal: AbortSignal) {
    const remove = () => {
      if (t.inserted) return;
      const index = s.queue.indexOf(t);
      if (index !== -1) { s.queue.splice(index, 1); t.reject(cancelled()); }
      t.controller.abort();
    };
    signal.addEventListener('abort', remove, { once: true });
    return t.ack.finally(() => signal.removeEventListener('abort', remove));
  }

  private cancel(s: Session) {
    for (const turn of s.queue.splice(0)) turn.reject(cancelled());
    if (!s.turn?.committed) s.turn?.controller.abort();
  }

  private async close(s: Session) {
    if (s.closing) return s.closing;
    if (!s.active) return;
    s.closing = (async () => {
      this.cancel(s);
      await s.done;
      try { await s.pi?.close(); }
      finally { s.pi = undefined; s.active = false; }
    })();
    try { await s.closing; } finally { s.closing = undefined; }
  }

  async request(method: string, params: Record<string, unknown>, signal: AbortSignal) {
    if (method === 'initialize') {
      if (this.used) throw new Fault(-32600);
      const { protocolVersion: version, info } = params;
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > 65535 ||
        !record(info) || typeof info.name !== 'string' || typeof info.version !== 'string') invalid();
      if (version < 2) throw new Fault(-32022, { requested: version, supported: [2] });
      this.initialized = true;
      return { protocolVersion: 2, info: { name: 'ursi-pi-executor', version: '0.1.0' },
        capabilities: { session: { systemPrompt: { mode: { override: {} } } } } };
    }
    if (!this.initialized) throw new Fault(-32600);
    this.used = true;
    switch (method) {
      case 'session/new': return this.open(params, signal);
      case 'session/list': {
        const cwd = params.cwd == null ? undefined : path(params.cwd);
        if (params.cursor != null) invalid();
        return { sessions: [...this.sessions.values()].filter(s => !cwd || cwd === s.cwd)
          .map(s => ({ sessionId: s.id, cwd: s.cwd })) };
      }
      case 'session/prompt': case 'session/resume': case 'session/close': {
        const { sessionId } = params;
        if (typeof sessionId !== 'string') invalid();
        const s = this.sessions.get(sessionId);
        if (method === 'session/close') { if (s) await this.close(s); return {}; }
        if (!s || (method === 'session/prompt' && !s.active)) throw new Fault(-32002, { sessionId });
        if (method === 'session/resume') return this.resume(s, params, signal);
        if (s.closing) throw cancelled();
        return this.enqueue(s, params, signal);
      }
      default: throw new Fault(-32601);
    }
  }

  notification(method: string, params: Record<string, unknown>) {
    if (!this.initialized || method !== 'session/cancel' || typeof params.sessionId !== 'string') return;
    this.used = true;
    const s = this.sessions.get(params.sessionId);
    if (s?.active) this.cancel(s);
  }

  async shutdown() {
    this.abort.abort();
    await Promise.allSettled([...this.sessions.values()].map(s => this.close(s)));
  }
}

function id(value: unknown): value is Id { return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)); }
function serve(env: ReturnType<typeof acpEnvironment>) {
  let stopped = false;
  const pending = new Map<Id, { controller: AbortController; done: Promise<void> }>();
  const send = (value: object) => {
    if (stopped) return;
    if (process.stdout.writableLength >= 8 * 1024 * 1024) { stop(true); return; }
    process.stdout.write(JSON.stringify(value) + '\n');
  };
  const agent = new Agent(env, send);
  function stop(failed = false) {
    if (stopped) return;
    stopped = true;
    process.stdin.pause();
    if (failed) { process.exitCode = 1; process.stdout.destroy(); }
    const timeout = setTimeout(() => process.exit(1), 5000);
    timeout.unref();
    for (const { controller } of pending.values()) controller.abort();
    void Promise.allSettled([agent.shutdown(), ...[...pending.values()].map(r => r.done)])
      .then(() => clearTimeout(timeout));
  }
  const error = (id: Id | null, e: unknown) => {
    const fault = e instanceof Fault ? e : new Fault(-32603);
    send({ jsonrpc: '2.0', id, error: { code: fault.code, message: fault.message, ...(fault.data ? { data: fault.data } : {}) } });
  };
  function frame(raw: Buffer) {
    let message: unknown;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { error(null, new Fault(-32700)); return; }
    if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      ('id' in message && !id(message.id))) { error(null, new Fault(-32600)); return; }
    const { method, id: key } = message;
    const params = message.params ?? {};
    if (key === undefined) {
      if (record(params)) {
        if (method === '$/cancel_request' && id(params.requestId)) pending.get(params.requestId)?.controller.abort();
        else agent.notification(method, params);
      }
      return;
    }
    if (!id(key)) return;
    if (pending.has(key)) { stop(true); return; }
    if (pending.size >= 128) { error(key, new Fault(-32001)); return; }
    if (!record(params)) { error(key, new Fault(-32602)); return; }
    const controller = new AbortController();
    const done = agent.request(method, params, controller.signal).then(
      result => send({ jsonrpc: '2.0', id: key, result }),
      failure => error(key, controller.signal.aborted && !(failure instanceof Fault) ? cancelled() : failure),
    ).finally(() => pending.delete(key));
    pending.set(key, { controller, done });
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  process.stdin.on('data', (data: Buffer) => {
    for (let from = 0; !stopped && from < data.length;) {
      const newline = data.indexOf(10, from);
      const end = newline === -1 ? data.length : newline;
      const piece = data.subarray(from, end);
      bytes += piece.length;
      if (bytes >= FRAME_LIMIT) { stop(true); return; }
      if (piece.length) chunks.push(piece);
      if (newline === -1) break;
      frame(Buffer.concat(chunks, bytes));
      chunks.length = bytes = 0;
      from = end + 1;
    }
  });
  process.stdin.on('end', () => stop(bytes !== 0));
  process.stdin.on('error', () => stop(true));
  process.stdout.on('error', () => stop(true));
}

try { serve(acpEnvironment(process.env)); }
catch { process.stderr.write('Managed Pi configuration unavailable\n'); process.exitCode = 1; }
