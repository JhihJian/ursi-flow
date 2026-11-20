import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runPi } from '../src/pi-executor/session.ts';
import { schemaDigest, loadPolicy } from '../src/pi-executor/policy.ts';
import { callBusinessTool } from '../src/pi-executor/tool-mcp.ts';
import { openWorkspace, readInput, listInputs, publishAnswer } from '../src/pi-executor/session-files.ts';

const signal = new AbortController().signal;
const schema = { required: ['id'], type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false };
const ref = { id: 'tickets.get', schemaDigest: schemaDigest(schema) };
const secret = 'test-secret-$LITERAL';
const token = 'private-mcp-token';

async function serve(t, handle) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await handle(req, res, JSON.parse(Buffer.concat(chunks)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, baseUrl = 'https://example.invalid') {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ws = join(dir, 'workspace');
  await mkdir(join(ws, 'inputs'), { recursive: true });
  await mkdir(join(ws, 'artifacts'));
  const path = join(dir, 'policy.json');
  const policy = { models: [{ id: 'checked-v1', provider: { model: 'fixture', apiKey: secret, baseUrl } }], tools: [] };
  async function save() {
    await writeFile(path + '.new', JSON.stringify(policy), { mode: 0o600 });
    await rename(path + '.new', path);
  }
  await save();
  const prev = process.env.URSI_PI_POLICY;
  process.env.URSI_PI_POLICY = path;
  t.after(() => { if (prev === undefined) delete process.env.URSI_PI_POLICY; else process.env.URSI_PI_POLICY = prev; });
  return { ws, path, policy, save, config: { systemPrompt: '固定系统指令。', modelProfile: 'checked-v1',
    skills: [{ id: 'audit', revision: 11, content: '核对工单正文。' }], tools: [] } };
}
function stream(res, delta, finish = 'stop') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [d, reason] of [[delta, null], [{}, finish]]) res.write('data: ' + JSON.stringify({ id: 'test', model: 'fixture',
    object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: reason }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
function toolCall(res, name, args) {
  stream(res, { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
}
async function mcp(t, f, customize) {
  const calls = [];
  const url = await serve(t, async (req, res, msg) => {
    calls.push({ msg, headers: req.headers });
    if (await customize?.(msg, res)) return;
    if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } }
      : msg.method === 'tools/list' ? { tools: [{ name: 'get', inputSchema: schema }] }
      : { content: [{ type: 'text', text: '工单有效。' }] };
    res.writeHead(200, { 'content-type': 'application/json', ...(msg.method === 'initialize' ? { 'mcp-session-id': 'session-secret' } : {}) });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  f.policy.tools = [{ id: ref.id, url, inputSchema: schema, name: 'get', readOnly: true, token }];
  await f.save();
  return calls;
}

test('隔离 SDK 按冻结系统提示、skill 和工作指令调用受限输入与业务工具，发布最终正文', async t => {
  const requests = [];
  const auth = [];
  const provider = await serve(t, (req, res, body) => {
    auth.push(req.headers.authorization); requests.push(body);
    if (requests.length === 1) toolCall(res, 'read_input', { path: 'ticket.md' });
    else if (requests.length === 2) toolCall(res, 'business_1', { id: 'T-7' });
    else stream(res, { role: 'assistant', content: '# 核对成功' });
  });
  const f = await fixture(t, provider);
  const calls = await mcp(t, f);
  f.config.tools = [ref];
  await writeFile(join(f.ws, 'AGENTS.md'), 'DO-NOT-LOAD');
  await writeFile(join(f.ws, 'inputs/ticket.md'), 'T-7 材料');
  await runPi(f.config, f.ws, '/skill:untrusted 请核对材料', signal);
  assert.deepEqual(await readdir(join(f.ws, 'artifacts')), ['answer.md']);
  assert.equal(await readFile(join(f.ws, 'artifacts/answer.md'), 'utf8'), '# 核对成功');
  assert.equal(requests.length, 3);
  assert.deepEqual(new Set(requests[0].tools.map(t => t.function.name)), new Set(['read_input', 'list_inputs', 'business_1']));
  assert.deepEqual(auth, Array(3).fill(`Bearer ${secret}`));
  const messages = requests[0].messages;
  assert.match(JSON.stringify(messages[0]), /固定系统指令/);
  assert.match(JSON.stringify(messages[0]), /核对工单正文/);
  assert.equal(messages.at(-1).role, 'user');
  assert.deepEqual(messages.at(-1).content, [{ type: 'text', text: '/skill:untrusted 请核对材料' }]);
  assert.doesNotMatch(JSON.stringify(requests), /DO-NOT-LOAD|private-mcp-token|test-secret|session-secret/);
  assert.match(JSON.stringify(requests[1].messages.at(-1)), /T-7 材料/);
  assert.match(JSON.stringify(requests[2].messages.at(-1)), /工单有效/);
  assert.deepEqual(calls.map(c => c.msg.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  for (const { headers } of calls.slice(1)) {
    assert.equal(headers['mcp-session-id'], 'session-secret');
    assert.equal(headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(headers.authorization, 'Bearer ' + token);
  }
  assert.deepEqual(calls.at(-1).msg.params, { name: 'get', arguments: { id: 'T-7' } });
});

test('撤销和 schema 漂移在 tools/call 之前生效', async t => {
  const f = await fixture(t);
  let revokeDuringDiscovery = false;
  const calls = await mcp(t, f, async msg => {
    if (revokeDuringDiscovery && msg.method === 'tools/list') { f.policy.tools = []; await f.save(); }
  });
  const invoke = () => callBusinessTool(f.path, ref, { id: '1' }, signal);
  assert.equal(await invoke(), '工单有效。');
  const granted = f.policy.tools[0];
  f.policy.tools = [{ ...granted, readOnly: false }]; await f.save();
  await assert.rejects(invoke, /^Error: Business tool unavailable$/);
  f.policy.tools = [{ ...granted, inputSchema: { type: 'object' } }]; await f.save();
  await assert.rejects(invoke);
  assert.equal(calls.length, 4);
  // Local policy and pinned digest agree, but the server still lists the old schema.
  await assert.rejects(() => callBusinessTool(f.path, { ...ref, schemaDigest: schemaDigest({ type: 'object' }) }, {}, signal));
  f.policy.tools = [granted]; await f.save();
  revokeDuringDiscovery = true;
  await assert.rejects(invoke);
  await assert.rejects(invoke);
  assert.equal(calls.filter(c => c.msg.method === 'tools/call').length, 1);
});

test('MCP 拒绝重定向、超限响应、远程错误及回显的凭据', async t => {
  const f = await fixture(t);
  let visits = 0, mode = 'redirect';
  const target = await serve(t, (_req, res) => { visits++; res.end(); });
  await mcp(t, f, (msg, res) => {
    if (mode === 'redirect') { res.writeHead(307, { location: target }).end(); return true; }
    if (msg.method !== 'tools/call') return false;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'large') res.end(' '.repeat(512 * 1024 + 1));
    else res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(mode === 'error' ? { error: { message: token } } : { result: { content: [{ type: 'text', text: token }] } }) }));
    return true;
  });
  for (mode of ['redirect', 'large', 'error', 'echo']) await assert.rejects(() => callBusinessTool(f.path, ref, {}, signal), /^Error: Business tool unavailable$/);
  assert.equal(visits, 0);
});

test('递归摘要固定键序并保留数组顺序，策略文件必须私有，远端 http 不受信', async t => {
  const digest = createHash('sha256').update('{"10":[{"a":0,"z":1},2],"2":true}').digest('hex');
  assert.equal(schemaDigest({ '2': true, '10': [{ z: 1, a: 0 }, 2] }), digest);
  const f = await fixture(t);
  await chmod(f.path, 0o644);
  await assert.rejects(() => loadPolicy(f.path));
  await chmod(f.path, 0o600);
  const linkedDir = join(f.ws, 'linked-dir'); await symlink(join(f.path, '..'), linkedDir);
  await assert.rejects(() => loadPolicy(join(linkedDir, 'policy.json')));
  const alias = join(f.ws, 'alias'); await link(f.path, alias);
  await assert.rejects(() => loadPolicy(f.path));
  await rm(alias);
  await writeFile(f.path, ' '.repeat(1024 * 1024) + JSON.stringify(f.policy));
  await assert.rejects(() => loadPolicy(f.path));
  f.policy.models[0].provider.baseUrl = 'http://not-loopback.example'; await f.save();
  await assert.rejects(() => loadPolicy(f.path));
});

test('文件读取拒绝遍历、各级链接、超限和非 UTF-8，发布不覆盖已有文件', async t => {
  const f = await fixture(t);
  const root = await openWorkspace(f.ws); t.after(() => root.close());
  const inputs = join(f.ws, 'inputs');
  await mkdir(join(inputs, 'nested')); await writeFile(join(inputs, 'nested/材料.md'), '合法');
  assert.equal(await readInput(root, 'nested/材料.md'), '合法');
  assert.deepEqual(JSON.parse(await listInputs(root, '')), ['nested/']);
  await symlink(f.path, join(inputs, 'sym')); await symlink(inputs, join(inputs, 'redirect'));
  await link(f.path, join(inputs, 'hard')); await writeFile(join(inputs, 'large'), Buffer.alloc(256 * 1024 + 1));
  await writeFile(join(inputs, 'binary'), Buffer.from([255]));
  for (const path of ['../policy.json', f.path, 'sym', 'redirect/nested/材料.md', 'hard', 'large', 'binary'])
    await assert.rejects(() => readInput(root, path));
  await rename(inputs, inputs + '-saved'); await symlink(inputs + '-saved', inputs);
  await assert.rejects(() => readInput(root, 'nested/材料.md'));
  await symlink(f.path, join(f.ws, 'artifacts/answer.md'));
  await assert.rejects(() => publishAnswer(root, 'new', signal));
  assert.deepEqual(await readdir(join(f.ws, 'artifacts')), ['answer.md']);
  assert.equal(JSON.parse(await readFile(f.path)).models[0].provider.apiKey, secret);
});

test('远端声明可写或只读标记类型错误时不发送 tools/call', async t => {
  const f = await fixture(t);
  let hint = false;
  const calls = await mcp(t, f, (msg, res) => {
    if (msg.method !== 'tools/list') return false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      tools: [{ name: 'get', inputSchema: schema, annotations: { readOnlyHint: hint } }],
    } }));
    return true;
  });
  for (hint of [false, 'true']) await assert.rejects(() => callBusinessTool(f.path, ref, { id: 'T' }, signal));
  assert.equal(calls.filter(c => c.msg.method === 'tools/call').length, 0);
});

test('模型失败、截断和空回复不发布制品或泄露诊断', async t => {
  let mode = 'error';
  const url = await serve(t, (_req, res) => {
    if (mode === 'error') res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: secret } }));
    else stream(res, { role: 'assistant', content: mode === 'empty' ? '   ' : 'partial' }, mode === 'length' ? 'length' : 'stop');
  });
  const f = await fixture(t, url);
  for (mode of ['error', 'length', 'empty']) {
    await assert.rejects(() => runPi(f.config, f.ws, 'run', signal), /^Error: Pi run failed$/);
    assert.deepEqual(await readdir(join(f.ws, 'artifacts')), []);
  }
});

test('未授权工具、超长工作指令及预先取消均不发出模型请求', async t => {
  let requests = 0;
  const url = await serve(t, (_req, res) => { requests++; stream(res, { role: 'assistant', content: 'unexpected' }); });
  const f = await fixture(t, url);
  await assert.rejects(() => runPi({ ...f.config, tools: [ref] }, f.ws, 'run', signal), /^Error: Pi run failed$/);
  await assert.rejects(() => runPi(f.config, f.ws, '界'.repeat(90_000), signal), /^Error: Pi run failed$/);
  await assert.rejects(() => runPi(f.config, f.ws, 'run', AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(join(f.ws, 'artifacts')), []);
});

test('目录、文件和最终正文按条数与 UTF-8 字节数限制', async t => {
  const f = await fixture(t);
  const root = await openWorkspace(f.ws); t.after(() => root.close());
  const inputs = join(f.ws, 'inputs');
  const input = '字'.repeat(87381) + 'x'; // 256 KiB
  await writeFile(join(inputs, 'text'), input);
  assert.equal(await readInput(root, 'text'), input);
  await Promise.all(Array.from({ length: 255 }, (_, i) => writeFile(join(inputs, String(i)), '')));
  assert.equal(JSON.parse(await listInputs(root, '')).length, 256);
  await writeFile(join(inputs, 'extra'), '');
  await assert.rejects(() => listInputs(root, ''));
  const answer = input.repeat(4);
  await assert.rejects(() => publishAnswer(root, answer + 'x', signal));
  await assert.rejects(() => publishAnswer(root, answer, AbortSignal.abort()));
  assert.deepEqual(await readdir(join(f.ws, 'artifacts')), []);
  await publishAnswer(root, answer, signal);
  assert.equal(await readFile(join(f.ws, 'artifacts/answer.md'), 'utf8'), answer);
});

test('取消正在等待的 MCP 调用会关闭连接且不发布结果', { timeout: 8000 }, async t => {
  const controller = new AbortController();
  const closed = Promise.withResolvers();
  let requests = 0;
  const url = await serve(t, (_req, res) => {
    if (++requests === 1) toolCall(res, 'business_1', { id: 'T' });
    else stream(res, { role: 'assistant', content: 'unexpected' });
  });
  const f = await fixture(t, url);
  const calls = await mcp(t, f, (msg, res) => {
    if (msg.method !== 'tools/call') return false;
    res.on('close', closed.resolve);
    controller.abort();
    return true;
  });
  await assert.rejects(() => runPi({ ...f.config, tools: [ref] }, f.ws, 'wait', controller.signal), { name: 'AbortError' });
  await closed.promise;
  assert.equal(calls.at(-1).msg.method, 'tools/call');
  assert.equal(requests, 1);
  assert.deepEqual(await readdir(join(f.ws, 'artifacts')), []);
});

test('取消真实中止正在接收的模型请求，无成功制品', { timeout: 8000 }, async t => {
  const controller = new AbortController();
  const closed = Promise.withResolvers();
  const url = await serve(t, (_req, res) => {
    res.on('close', closed.resolve);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n');
    setTimeout(() => controller.abort(), 10);
  });
  const f = await fixture(t, url);
  await assert.rejects(() => runPi(f.config, f.ws, 'wait', controller.signal), { name: 'AbortError' });
  await closed.promise;
  assert.deepEqual(await readdir(join(f.ws, 'artifacts')), []);
});
