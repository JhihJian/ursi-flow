import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ref = { id: 'reviewer', revision: 7 };
const token = 'test-platform-bearer';
const markdown = `---
name: 审核
description: 测试平台委派
variables:
  任务:
    description: 输入标记
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> review[审核]
  review -->|通过| finish((结束))
  review -->|退回| finish
\`\`\`

## 审核

\`\`\`新建Agent
请处理 {var.任务}
\`\`\`

### 通过

| 变量 | 含义 |
| --- | --- |
| 摘要 | 审核结果 |

材料通过。

### 退回

材料需要调整。
`;
let home, daemon, mock, scenario;
const violations = [];

async function rpc(op, args) {
  const socket = connect(join(home, 'runtime.sock'));
  socket.end(JSON.stringify({ v: 1, op, args }));
  const chunks = [];
  for await (const chunk of socket) chunks.push(chunk);
  const reply = JSON.parse(Buffer.concat(chunks));
  if (reply.error) throw Object.assign(new Error(reply.error), { code: reply.code });
  return reply.data;
}
async function boot() {
  daemon = spawn(process.execPath, [fileURLToPath(new URL('../dist/machine/daemon.js', import.meta.url))], {
    env: { ...process.env, URSI_FLOW_HOME: home, URSI_FLOWD_NOTIFY: '1',
      URSI_EXECUTOR_PLATFORM_URL: `http://127.0.0.1:${mock.address().port}`, URSI_EXECUTOR_PLATFORM_TOKEN: token },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const ready = await Promise.race([once(daemon.stdout, 'data'), once(daemon, 'exit')]);
  assert.equal(String(ready[0]), 'ready-v1\n');
}
async function shutdown() {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const closed = once(daemon, 'exit');
    daemon.kill('SIGTERM');
    await closed;
  }
}
async function until(fn) {
  for (let i = 0; i < 300; ++i) {
    const result = await fn();
    if (result) return result;
    await delay(50);
  }
  assert.fail(`等待超时：${JSON.stringify(scenario)}`);
}
function statusOf(id, expected) {
  return until(async () => {
    const job = await rpc('run.get', { id });
    if (job.status !== 'running') assert.equal(job.status, expected, job.error);
    return job.status === expected && job;
  });
}
async function start(id, options) {
  scenario = { id, calls: [], status: 'running', artifact: { outcome: '通过', variables: { 摘要: '齐全' } }, ...options };
  const args = { id, flow: 'review', cwd: home, variables: { 任务: id }, executorRef: ref };
  const job = await rpc('run.start', args);
  assert.deepEqual(job.executorRef, ref);
  return args;
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'flow-platform-'));
  mock = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const { method, url } = req, s = scenario;
      if (method === 'GET' && url === '/api/v2/node-executors/reviewer/7') return res.end(JSON.stringify(ref));
      if (method === 'GET' && url.startsWith('/api/v2/node-executors/')) return res.writeHead(404).end();
      s.calls.push([method, url]);
      if (method === 'PUT') {
        // Read the real worker's facts while dispatch is in flight, not after its receipt.
        const facts = JSON.parse(await readFile(join(home, 'runs', s.id, 'facts.json'), 'utf8'));
        s.attempt = facts.nodeRuns.at(-1).attemptId;
        assert.match(s.attempt, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
        assert.equal(url, `/api/v2/executor-attempts/${s.attempt}`);
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        assert.match(body.workInstruction.text, new RegExp(`请处理 ${s.id}`));
        assert.deepEqual(body, { executorRef: ref, workInstruction: { text: body.workInstruction.text, encoding: 'utf-8' },
          runConfig: { nodeContract: { outcomes: ['通过', '退回'], variables: ['任务', '摘要'] } } });
        if (s.dropStart) return res.destroy();
      } else if (method === 'POST') {
        assert.equal(url, `/api/v2/executor-attempts/${s.attempt}/cancel`);
        if (s.confirmCancel) s.status = 'cancelled';
        return res.destroy(); // cancel receipt can disappear too
      } else if (url === '/api/v2/directories/frozen-output/file?path=flow-outcome.json') {
        assert.equal(method, 'GET');
        assert.equal(s.status, 'succeeded');
        res.writeHead(s.missing ? 404 : 200, { 'Content-Type': 'application/octet-stream' });
        return res.end(JSON.stringify(s.artifact));
      } else {
        assert.equal(method, 'GET');
        assert.equal(url, `/api/v2/executor-attempts/${s.attempt}`);
      }
      res.end(JSON.stringify({ attemptId: s.attempt, status: s.status,
        ...(s.status === 'succeeded' && { artifactDirectoryId: 'frozen-output' }) }));
    } catch (e) {
      violations.push(e);
      res.writeHead(400).end();
    }
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  await boot();
  await rpc('flow.create', { id: 'review', files: { 'FLOW.md': markdown } });
});
after(async () => {
  await shutdown();
  if (mock) await new Promise(resolve => mock.close(resolve));
  if (home) await rm(home, { recursive: true, force: true });
  if (violations.length) throw violations[0];
});

test('登记 Run 前拒绝无效节点执行器', async () => {
  const args = { id: 'bad-ref', flow: 'review', cwd: home, variables: { 任务: 'test' }, executorRef: { ...ref, revision: 99 } };
  await assert.rejects(rpc('run.start', args), /404/);
  await assert.rejects(rpc('run.get', {id: args.id}));
});

test('启动回执丢失并重启 daemon，恢复只查询原尝试并按制品选边', async () => {
  const args = await start('lost', { dropStart: true, status: 'unverified' });
  await until(() => scenario.calls.some(([method]) => method === 'GET'));
  assert.equal((await rpc('run.history', { id: args.id })).routeDecisions.length, 0);
  await shutdown();
  await boot();
  assert.equal((await rpc('run.start', args)).status, 'unknown');
  await assert.rejects(rpc('run.start', { ...args, executorRef: { ...ref, revision: 8 } }), { code: 'conflict' });
  scenario.status = 'succeeded';
  await rpc('run.resume', { id: args.id });
  await statusOf(args.id, 'completed');
  const history = await rpc('run.history', { id: args.id });
  assert.equal(history.nodeRuns.length, 1);
  assert.equal(history.nodeRuns[0].attemptId, scenario.attempt);
  assert.deepEqual(history.nodeRuns[0].outcome, { result: '通过', variables: { 摘要: '齐全' } });
  assert.deepEqual(history.routeDecisions.map(d => d.result), ['通过']);
  assert.deepEqual(history.recoveries.map(r => r.strategy), ['inspect_attempt']);
  assert.equal(scenario.calls.filter(([method]) => method === 'PUT').length, 1);
  assert.ok(!JSON.stringify(history).includes(token));
});

test('取消未确认保持 unknown；重试原 ID，确认后停止且不选边', async () => {
  const { id } = await start('cancel');
  await until(() => scenario.calls.some(([method]) => method === 'GET'));
  const pending = await rpc('run.stop', { id });
  assert.equal(pending.status, 'unknown');
  assert.equal(pending.stopRequested, true);
  await assert.rejects(rpc('run.resume', { id }));
  scenario.confirmCancel = true;
  assert.equal((await rpc('run.stop', { id })).status, 'stopped');
  assert.deepEqual(scenario.calls.slice(-4).map(([method]) => method), ['POST', 'GET', 'POST', 'GET']);
  assert.equal(scenario.calls.filter(([method]) => method === 'PUT').length, 1);
  assert.equal((await rpc('run.history', { id })).routeDecisions.length, 0);
});

for (const [id, options, error] of [
  ['missing', { missing: true }, /404/],
  ['bad-outcome', { artifact: { outcome: '未声明' } }, /不允许结果/],
  ['bad-variables', { artifact: { outcome: '退回', variables: { 摘要: '其他结果的变量' } } }, /不允许变量/],
]) test(`成功回执不能代替合法节点结果：${id}`, async () => {
  await start(id, { status: 'succeeded', ...options });
  await statusOf(id, 'failed');
  const history = await rpc('run.history', { id });
  assert.match(history.nodeRuns[0].error.summary, error);
  assert.equal(history.routeDecisions.length, 0);
});
