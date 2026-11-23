import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bin = fileURLToPath(new URL('../dist/pi-executor/acp.js', import.meta.url));
const init = { protocolVersion: 2, info: { name: 'pi-acp-test', version: '1' }, capabilities: {} };
const options = { timeout: 20_000 };
const deadline = () => AbortSignal.timeout(5_000);
const text = text => ({ type: 'text', text });
const digest = data => createHash('sha256').update(data).digest('hex');
const secret = 'fake-local-provider-key';

// Preserve wire order so assertions can compare replies and asynchronous updates.
function connect(cwd, env) {
  const child = spawn(process.execPath, [bin], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const changed = new EventEmitter();
  const frames = [];
  let buffer = '', stderr = '', failure, exit, nextId = 0;
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    exit = { code, signal };
    changed.emit('frame');
    resolve();
  }));
  const fail = error => { failure ??= error; changed.emit('frame'); };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  child.stdout.setEncoding('utf8').on('data', data => {
    buffer += data;
    try {
      for (let end; (end = buffer.indexOf('\n')) !== -1;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const frame = JSON.parse(line);
        assert.equal(frame.jsonrpc, '2.0', line);
        if (frame.method !== undefined) assert.equal(frame.method, 'session/update', line);
        else assert.ok(Number.isInteger(frame.id) && ('result' in frame) !== ('error' in frame), line);
        frames.push(frame);
      }
      changed.emit('frame');
    } catch (error) { fail(error); }
  });

  async function waitFor(predicate, label, from = 0) {
    const signal = deadline();
    while (true) {
      if (failure) throw failure;
      const frame = frames.slice(from).find(predicate);
      if (frame) return frame;
      assert.equal(exit, undefined, `${label}: Pi exited. stderr: ${stderr}`);
      try { await once(changed, 'frame', { signal }); }
      catch (cause) { throw new Error(`Timed out waiting for ${label}. stderr: ${stderr}`, { cause }); }
    }
  }

  function batch(...calls) {
    const outgoing = calls.map(({ method, params, notification }) => ({ jsonrpc: '2.0', method, params,
      ...(!notification ? { id: ++nextId } : {}) }));
    const pending = outgoing.filter(frame => frame.id !== undefined).map(({ id, method }) =>
      waitFor(frame => frame.id === id, method, frames.length));
    child.stdin.write(outgoing.map(frame => JSON.stringify(frame) + '\n').join(''));
    return Promise.all(pending);
  }
  async function request(method, params) { return (await batch({ method, params }))[0]; }
  async function rpc(method, params) {
    const response = await request(method, params);
    assert.equal(response.error, undefined, `${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  }
  async function reject(method, params, code) {
    const response = await request(method, params);
    assert.ok(Number.isInteger(response.error?.code), `${method}: expected JSON-RPC error, got ${JSON.stringify(response)}`);
    if (code !== undefined) assert.equal(response.error.code, code);
  }
  function isUpdate(frame, sessionId) {
    return frame.method === 'session/update' && frame.params.sessionId === sessionId;
  }
  return {
    frames, request, rpc, reject, batch,
    notify: (method, params) => { void batch({ method, params, notification: true }); },
    updates: (sessionId, from = 0, before = frames.length) => frames.slice(from, before)
      .filter(frame => isUpdate(frame, sessionId)).map(frame => frame.params.update),
    update: (sessionId, predicate, from = 0) => waitFor(
      frame => isUpdate(frame, sessionId) && predicate(frame.params.update), 'session/update', from),
    async finish(expectedCode = 0) {
      child.stdin.end();
      if (!exit) await once(child, 'close', { signal: deadline() });
      assert.ifError(failure);
      assert.equal(buffer, '', 'stdout must end on a JSONL boundary');
      if (expectedCode === 'nonzero') assert.ok(Number.isInteger(exit.code) && exit.code !== 0, stderr);
      else assert.deepEqual(exit, { code: expectedCode, signal: null }, stderr);
    },
    async dispose() {
      if (!exit) child.kill('SIGKILL');
      await closed;
    },
  };
}

function writeChunk(res, delta, finishReason = null) {
  res.write('data: ' + JSON.stringify({ id: 'fixture-completion', model: 'fixture', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\n');
}
function finishStream(res, delta, stop = 'stop') {
  writeChunk(res, { role: 'assistant', ...delta });
  writeChunk(res, {}, stop);
  res.end('data: [DONE]\n\n');
}
function toolCall(res, number, name, args) {
  finishStream(res, { tool_calls: [{ index: 0, id: `provider-call-${number}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
}

async function fixture(t, { production = false, nodeContract } = {}) {
  await access(bin);
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'pi-acp-'));
  const clients = [];
  const modelRequests = [];
  const resourceRequests = [];
  const providerChanged = new EventEmitter();
  let providerError;
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      resourceRequests.push(req.url);
      res.end('NETWORK_RESOURCE_BODY_MUST_NOT_BE_READ');
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(req.headers.authorization, `Bearer ${secret}`);
      const closed = new Promise(resolve => res.once('close', resolve));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting for the test\n\n');
      modelRequests.push({ body, res, closed });
    } catch (error) {
      providerError = error;
      res.destroy();
    } finally { providerChanged.emit('request'); }
  });
  t.after(async () => {
    await Promise.all(clients.map(client => client.dispose()));
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await stopped;
    await rm(dir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = join(dir, 'executor');
  const attempt = join(root, randomUUID());
  const cwd = production ? join(attempt, 'workspace') : join(root, 'generic');
  const artifacts = join(cwd, 'artifacts');
  const policyPath = join(dir, 'policy.json');
  const env = { URSI_EXECUTOR_ROOT: root, URSI_PI_POLICY: policyPath };
  const snapshotPath = join(attempt, 'agent-config.json');
  const jobPath = join(attempt, 'acp-job.json');
  const privateDir = path => mkdir(path, { mode: 0o700 });
  await privateDir(root);
  if (production) await privateDir(attempt);
  await privateDir(cwd);
  await writeFile(policyPath, JSON.stringify({ models: ['default', 'pinned'].map(id => ({
    id, provider: { api: 'openai-completions', model: `fixture-${id}`, apiKey: secret, baseUrl: `${origin}/v1` },
  })), tools: [] }), { mode: 0o600 });
  const companionText = '冻结附件的文本标记';
  const companionBinary = Buffer.from([0xff, 0x00, 0x80, 0x42]);
  if (production) {
    await privateDir(join(cwd, 'inputs'));
    await privateDir(artifacts);
    const skillFile = (path, data) => ({ path, contentBase64: data.toString('base64'), sha256: digest(data) });
    const snapshot = JSON.stringify({ systemPrompt: 'SNAPSHOT_SYSTEM_PROMPT', modelProfile: 'pinned',
      skills: [{ id: 'audit', revision: 1, content: 'FROZEN_SKILL_INSTRUCTIONS', files: [
        skillFile('references/guide.txt', Buffer.from(companionText)), skillFile('assets/sample.bin', companionBinary),
      ] }], tools: [] });
    await writeFile(snapshotPath, snapshot, { mode: 0o400 });
    await writeFile(jobPath, JSON.stringify({ cwd, configDigest: digest(snapshot), nodeContract }), { mode: 0o400 });
    env.URSI_ACP_JOB = jobPath;
  }
  return {
    dir, cwd, artifacts, origin, snapshotPath, jobPath, companionText, companionBinary, modelRequests, resourceRequests,
    connect: () => {
      // Supply only the deployment variables, without inheriting ambient Pi settings or credentials.
      const client = connect(dir, env);
      clients.push(client);
      return client;
    },
    async model(number) {
      const signal = deadline();
      while (modelRequests.length < number && !providerError) await once(providerChanged, 'request', { signal });
      assert.ifError(providerError);
      return modelRequests[number - 1];
    },
  };
}

const nonemptyString = value => assert.ok(typeof value === 'string' && value.length > 0);
const idle = reason => update => update.sessionUpdate === 'state_update' && update.state === 'idle' && update.stopReason === reason;
const running = update => update.sessionUpdate === 'state_update' && update.state === 'running';
const systemText = body => body.messages.filter(msg => msg.role === 'system')
  .flatMap(msg => typeof msg.content === 'string' ? [msg.content] : msg.content.map(block => block.text)).join('\n');

async function initialize(client) {
  const result = await client.rpc('initialize', init);
  assert.equal(result.protocolVersion, 2);
  nonemptyString(result.info?.name);
  nonemptyString(result.info?.version);
  assert.ok(result.capabilities?.session?.systemPrompt?.mode?.override);
}

// The model sends no completion until the test observes the insertion ACK.
test('ACP v2 requires initialize.info and supports repeated generic prompts without workspace IO', options, async t => {
  const f = await fixture(t);
  const file = join(f.dir, 'unlinked-file.txt');
  await writeFile(file, 'FILE_RESOURCE_BODY_MUST_NOT_BE_READ');
  await writeFile(join(f.cwd, 'AGENTS.md'), 'WORKSPACE_CONTEXT_MUST_NOT_BE_READ');
  const client = f.connect();
  await client.reject('session/list', {}, -32600);
  await client.reject('initialize', { protocolVersion: 2, capabilities: {} }, -32602);
  const unsupported = await client.request('initialize', { ...init, protocolVersion: 1 });
  assert.deepEqual(unsupported.error?.data, { requested: 1, supported: [2] });
  assert.equal(unsupported.error?.code, -32022);
  await initialize(client);

  const baseline = await client.rpc('session/new', { cwd: f.cwd });
  const start = client.frames.length;
  await client.rpc('session/prompt', { sessionId: baseline.sessionId, prompt: [text('baseline')] });
  const first = await f.model(1);
  // The Pi SDK adds its own cwd metadata after the managed instructions.
  const base = systemText(first.body).split('<cwd>')[0].trim();
  nonemptyString(base);
  finishStream(first.res, { content: 'baseline response' });
  await client.update(baseline.sessionId, idle('end_turn'), start);
  await client.rpc('session/close', { sessionId: baseline.sessionId });

  const append = 'CLIENT_APPEND_SYSTEM_PROMPT';
  const { sessionId } = await client.rpc('session/new', { cwd: f.cwd, systemPrompt: { mode: 'append', content: [text(append)] } });
  const prompt = [text('只处理引用标签'),
    { type: 'resource_link', name: 'local reference', uri: pathToFileURL(file).href },
    { type: 'resource_link', name: 'network reference', uri: `${f.origin}/linked-resource` },
  ];
  for (const [n, blocks] of [[2, prompt], [3, [text('second turn')]]]) {
    const from = client.frames.length;
    const { messageId } = await client.rpc('session/prompt', { sessionId, prompt: blocks });
    nonemptyString(messageId);
    const { body, res } = await f.model(n);
    assert.equal(body.model, 'fixture-default');
    assert.deepEqual(body.tools ?? [], []);
    const system = systemText(body);
    assert.ok(system.includes(base.trim()) && system.indexOf(append) > system.indexOf(base.trim()), system);
    const user = JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1));
    assert.ok(user.includes(blocks[0].text), user);
    if (n === 2) {
      const echo = await client.update(sessionId, u => u.sessionUpdate === 'user_message' && u.messageId === messageId, from);
      assert.deepEqual(echo.params.update.content, blocks);
    }
    finishStream(res, { content: `reply ${n}` });
    await client.update(sessionId, idle('end_turn'), from);
  }
  await client.rpc('session/close', { sessionId });
  await client.finish();
  assert.equal(f.modelRequests.length, 3);
  assert.deepEqual(f.resourceRequests, []);
  assert.deepEqual(await readdir(f.cwd), ['AGENTS.md']);
  assert.doesNotMatch(JSON.stringify(f.modelRequests.map(request => request.body)), /(?:FILE|NETWORK)_RESOURCE_BODY_MUST_NOT_BE_READ|WORKSPACE_CONTEXT_MUST_NOT_BE_READ/);
});

test('production ACKs insertion while SSE is open, deduplicates, invokes frozen skills, and resumes retained history', options, async t => {
  const f = await fixture(t, { production: true });
  await writeFile(join(f.cwd, 'inputs/material.txt'), 'PRIVATE_INPUT_TOOL_RESULT');
  const client = f.connect();
  await initialize(client);
  const systemPrompt = { mode: 'override', content: [text('CLIENT_OVERRIDE_SYSTEM_PROMPT')] };
  const config = { cwd: f.cwd, systemPrompt };
  const { sessionId } = await client.rpc('session/new', config);
  nonemptyString(sessionId);
  const prompt = { sessionId, prompt: [text('核对材料')], idempotencyKey: 'one-production-insertion' };
  const before = client.frames.length;
  await client.reject('session/prompt', { ...prompt, prompt: [] }, -32602);
  const { messageId } = await client.rpc('session/prompt', prompt);
  nonemptyString(messageId);
  const request = await f.model(1);
  await client.update(sessionId, running, before);
  assert.equal(request.res.writableEnded, false);
  assert.deepEqual(await readdir(f.artifacts), []);
  assert.ok(!client.updates(sessionId, before).some(idle('end_turn')));
  assert.equal((await client.rpc('session/prompt', prompt)).messageId, messageId);

  const { body } = request;
  assert.equal(body.model, 'fixture-pinned');
  assert.match(systemText(body), /CLIENT_OVERRIDE_SYSTEM_PROMPT/);
  assert.match(systemText(body), /FROZEN_SKILL_INSTRUCTIONS/);
  assert.doesNotMatch(systemText(body), /SNAPSHOT_SYSTEM_PROMPT/);
  assert.deepEqual(body.messages.at(-1).content, prompt.prompt);
  assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ['list_inputs', 'read_input', 'read_skill_file']);
  const skillTool = body.tools.find(tool => tool.function.name === 'read_skill_file').function;
  assert.deepEqual([...skillTool.parameters.required].sort(), ['path', 'skillId']);
  toolCall(request.res, 1, 'read_skill_file', { skillId: 'audit', path: 'references/guide.txt' });

  const second = await f.model(2);
  assert.ok(JSON.stringify(second.body.messages.at(-1)).includes(f.companionText));
  toolCall(second.res, 2, 'read_skill_file', { skillId: 'audit', path: 'assets/sample.bin' });
  const third = await f.model(3);
  assert.ok(JSON.stringify(third.body.messages.at(-1)).includes(f.companionBinary.toString('base64')));
  toolCall(third.res, 3, 'read_input', { path: 'material.txt' });
  const fourth = await f.model(4);
  assert.match(JSON.stringify(fourth.body.messages.at(-1)), /PRIVATE_INPUT_TOOL_RESULT/);
  const answer = '# 核对成功';
  writeChunk(fourth.res, { role: 'assistant', content: answer });
  await client.update(sessionId, u => u.sessionUpdate === 'agent_message_chunk' && u.content.text.includes(answer), before);
  assert.equal(fourth.res.writableEnded, false);
  writeChunk(fourth.res, {}, 'stop');
  fourth.res.end('data: [DONE]\n\n');
  await client.update(sessionId, idle('end_turn'), before);
  assert.equal(await readFile(join(f.artifacts, 'answer.md'), 'utf8'), answer);
  assert.equal((await client.rpc('session/prompt', prompt)).messageId, messageId);
  await client.reject('session/prompt', { ...prompt, idempotencyKey: 'another-insertion' });

  const live = client.updates(sessionId, before);
  assert.deepEqual(live.filter(u => u.sessionUpdate === 'user_message').map(u => u.messageId), [messageId]);
  const tools = live.filter(u => u.sessionUpdate === 'tool_call_update');
  const started = tools.filter(u => u.status === 'in_progress');
  assert.deepEqual(started.map(u => u.name), ['read_skill_file', 'read_skill_file', 'read_input']);
  assert.equal(new Set(started.map(u => u.toolCallId)).size, 3);
  for (const [i, update] of started.entries()) {
    nonemptyString(update.toolCallId);
    assert.notEqual(update.toolCallId, `provider-call-${i + 1}`);
    assert.ok(tools.some(u => u.toolCallId === update.toolCallId && u.status === 'completed'));
  }
  await client.rpc('session/close', { sessionId });
  const list = async cwd => (await client.rpc('session/list', { cwd })).sessions.map(s => [s.sessionId, s.cwd]);
  assert.deepEqual(await list(f.cwd), [[sessionId, f.cwd]]);
  assert.deepEqual(await list(f.dir), []);
  await client.reject('session/resume', { ...config, sessionId, cwd: f.dir }, -32602);
  await client.reject('session/resume', { ...config, sessionId, replayFrom: { type: 'unsupported' } }, -32602);

  async function resume(replayFrom) {
    const from = client.frames.length;
    const response = await client.request('session/resume', { ...config, sessionId, replayFrom });
    assert.equal(response.error, undefined);
    const updates = client.updates(sessionId, from, client.frames.indexOf(response));
    assert.equal(updates.at(-1)?.sessionUpdate, 'state_update');
    assert.equal(updates.at(-1)?.state, 'idle');
    return updates.slice(0, -1);
  }
  assert.deepEqual(await resume(undefined), []);
  const replay = await resume({ type: 'start' });
  assert.equal(replay.at(-1)?.sessionUpdate, 'replay_complete');
  assert.equal(replay.filter(u => u.sessionUpdate === 'replay_complete').length, 1);
  assert.deepEqual(replay.filter(u => u.sessionUpdate === 'user_message').map(u => u.messageId), [messageId]);
  const replies = replay.filter(u => ['agent_message', 'agent_message_chunk'].includes(u.sessionUpdate));
  assert.match(JSON.stringify(replies), /核对成功/);
  assert.equal((await client.rpc('session/prompt', prompt)).messageId, messageId);
  await client.reject('session/prompt', { ...prompt, idempotencyKey: undefined });
  await client.rpc('session/close', { sessionId });
  await client.finish();
  assert.equal(f.modelRequests.length, 4);
  const wire = JSON.stringify(client.frames);
  assert.doesNotMatch(wire, /rawInput|rawOutput|tool_call_content_chunk|provider-call-|CLIENT_OVERRIDE_SYSTEM_PROMPT|PRIVATE_INPUT_TOOL_RESULT|references\/guide\.txt/);
  for (const value of [secret, f.companionText, f.companionBinary.toString('base64')]) assert.ok(!wire.includes(value));
});

test('session/cancel aborts an active provider stream without publishing an artifact', options, async t => {
  const f = await fixture(t, { production: true });
  const client = f.connect();
  await initialize(client);
  const { sessionId } = await client.rpc('session/new', { cwd: f.cwd });
  const from = client.frames.length;
  const prompt = { sessionId, prompt: [text('wait for cancellation')], idempotencyKey: 'cancelled-run' };
  const { messageId } = await client.rpc('session/prompt', prompt);
  const { res, closed } = await f.model(1);
  await client.update(sessionId, running, from);
  client.notify('session/cancel', { sessionId });
  await client.update(sessionId, idle('cancelled'), from);
  if (!res.destroyed) await once(res, 'close', { signal: deadline() });
  await closed;
  assert.equal(res.writableEnded, false, 'the model stream was aborted, not finished by the fixture');
  assert.deepEqual(await readdir(f.artifacts), []);
  assert.equal((await client.rpc('session/prompt', prompt)).messageId, messageId);
  await client.rpc('session/close', { sessionId });
  await client.finish();
  assert.equal(f.modelRequests.length, 1);
  assert.ok(!client.updates(sessionId, from).some(idle('end_turn')));
});

test('generic preflight opens and closes a private temporary cwd without model calls or workspace writes', options, async t => {
  const f = await fixture(t);
  const client = f.connect();
  await initialize(client);
  const cwd = await mkdtemp(join(f.dir, 'probe-'));
  const { sessionId } = await client.rpc('session/new', { cwd,
    systemPrompt: { mode: 'override', content: [text('Readiness probe. Do not perform any work.')] } });
  await client.rpc('session/close', { sessionId });
  await client.finish();
  assert.deepEqual(f.modelRequests, []);
  assert.deepEqual(await readdir(cwd), []);
});

test('cancelling before insertion answers both pending same-key requests without occupying the key', options, async t => {
  const f = await fixture(t, { production: true });
  const client = f.connect();
  await initialize(client);
  const { sessionId } = await client.rpc('session/new', { cwd: f.cwd });
  const from = client.frames.length;
  const params = { sessionId, prompt: [text('cancel before insertion')], idempotencyKey: 'retryable' };
  const dropped = await client.batch({ method: 'session/prompt', params }, { method: 'session/prompt', params },
    { method: 'session/cancel', params: { sessionId }, notification: true });
  for (const response of dropped) assert.equal(response.error?.code, -32800);
  assert.ok(!client.updates(sessionId, from).some(u => u.sessionUpdate === 'user_message'));
  assert.deepEqual(f.modelRequests, []);
  const { messageId } = await client.rpc('session/prompt', params);
  nonemptyString(messageId);
  const { res } = await f.model(1);
  finishStream(res, { content: 'retry completed' });
  await client.update(sessionId, idle('end_turn'), from);
  await client.rpc('session/close', { sessionId });
  await client.finish();
});

test('streaming never emits a live or replayed provider credential split across content deltas', options, async t => {
  const f = await fixture(t, { production: true });
  const client = f.connect();
  await initialize(client);
  const { sessionId } = await client.rpc('session/new', { cwd: f.cwd });
  await client.rpc('session/prompt', { sessionId, prompt: [text('redaction probe')] });
  const { res } = await f.model(1);
  const cutoff = 12;
  writeChunk(res, { role: 'assistant', content: 'prefix ' + secret.slice(0, cutoff) });
  await client.update(sessionId, u => u.sessionUpdate === 'agent_message_chunk' && u.content.text.includes('prefix'));
  finishStream(res, { content: secret.slice(cutoff) + ' suffix' });
  await client.update(sessionId, idle('error'));
  await client.rpc('session/close', { sessionId });
  await client.rpc('session/resume', { sessionId, cwd: f.cwd, replayFrom: { type: 'start' } });
  const trajectory = client.updates(sessionId).filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content.text).join('');
  assert.ok(!trajectory.includes(secret.slice(0, cutoff)) && !trajectory.includes(secret.slice(cutoff)));
  assert.match(trajectory, /prefix \[redacted\] suffix/);
  assert.deepEqual(await readdir(f.artifacts), []);
  await client.finish();
});

test('production job supplies a Flow node contract and publishes only the accepted outcome', options, async t => {
  const f = await fixture(t, { production: true, nodeContract: { outcomes: ['通过', '退回'], variables: ['摘要'] } });
  const client = f.connect();
  await initialize(client);
  const { sessionId } = await client.rpc('session/new', { cwd: f.cwd });
  const from = client.frames.length;
  await client.rpc('session/prompt', { sessionId, prompt: [text('提交节点结果')] });
  const { res, body } = await f.model(1);
  const schema = body.tools.find(tool => tool.function.name === 'submit_flow_outcome').function.parameters;
  assert.deepEqual(schema.properties.outcome.enum, ['通过', '退回']);
  const outcome = { outcome: '通过', variables: { 摘要: ['材料齐全', false] } };
  toolCall(res, 1, 'submit_flow_outcome', outcome);
  finishStream((await f.model(2)).res, { content: 'done' });
  await client.update(sessionId, idle('end_turn'), from);
  await client.rpc('session/close', { sessionId });
  await client.finish();
  assert.deepEqual(await readdir(f.artifacts), ['flow-outcome.json']);
  assert.deepEqual(JSON.parse(await readFile(join(f.artifacts, 'flow-outcome.json'), 'utf8')), outcome);
});

test('production fails closed on a writable job or a changed snapshot', options, async t => {
  for (const [label, invalidate] of [
    ['writable job', f => chmod(f.jobPath, 0o600)],
    ['changed snapshot', async f => {
      const original = await readFile(f.snapshotPath, 'utf8');
      await chmod(f.snapshotPath, 0o600);
      await writeFile(f.snapshotPath, original + '\n');
      await chmod(f.snapshotPath, 0o400);
    }],
  ]) await t.test(label, async t => {
    const f = await fixture(t, { production: true });
    await invalidate(f);
    const client = f.connect();
    await client.finish('nonzero');
    assert.deepEqual(f.modelRequests, []);
  });
});
