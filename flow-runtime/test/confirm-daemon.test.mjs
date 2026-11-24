import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// 本地 OpenAI 兼容服务：每次调用依次返回「已准备」，confirm 节点不需要模型参与。
const markdown = `---
name: 确认门禁
description: 全链路确认验收
variables:
  任务:
    description: 输入标记
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> prepare[准备]
  prepare -->|已准备| gate[确认]
  gate -->|通过| finish((结束))
  gate -->|退回| prepare
\`\`\`

## 准备

\`\`\`新建Agent
请处理 {var.任务}
\`\`\`
### 已准备

| 变量 | 含义 |
| --- | --- |
| 摘要 | 准备结果 |

准备完毕。

## 确认

\`\`\`confirm
请确认 {var.任务} 的准备结果。
\`\`\`
### 通过

材料通过。

### 退回

材料需要调整。
`;

let home, daemon, mock, requests;
const calls = [];

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
    env: { ...process.env, URSI_FLOW_HOME: home, URSI_FLOWD_NOTIFY: '1' },
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
  assert.fail('等待超时');
}
async function waitFor(id, expected) {
  return until(async () => {
    const job = await rpc('run.get', { id });
    if (job.status !== 'running' && job.status !== 'waiting_input') assert.equal(job.status, expected, job.error);
    return job.status === expected && job;
  });
}
async function waitForWaiting(id) {
  return until(async () => {
    const job = await rpc('run.get', { id });
    return job.status === 'waiting_input' && job;
  });
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'flow-confirm-'));
  mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    calls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    const turn = requests += 1;
    const args = turn === 1
      ? { outcome: '已准备', variables: { 摘要: '齐全' } }
      : { outcome: '已准备', variables: { 摘要: '再次齐全' } };
    const delta = {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call_${turn}`,
          type: 'function',
          function: { name: 'submit_flow_outcome', arguments: JSON.stringify(args) },
        },
      ],
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [chunk, stop] of [[delta, null], [{}, 'tool_calls']])
      res.write(
        'data: ' +
          JSON.stringify({
            id: `completion_${turn}`,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: chunk, finish_reason: stop }],
          }) +
          '\n\n',
      );
    res.end('data: [DONE]\n\n');
  });
  await new Promise((done) => mock.listen(0, '127.0.0.1', done));
  await boot();
  await rpc('flow.create', { id: 'gate', files: { 'FLOW.md': markdown } });
  await rpc('config.update', {
    workspace: join(home, 'workspace'),
    provider: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'fixture', model: 'fixture' },
  });
});
after(async () => {
  await shutdown();
  if (mock) await new Promise((r) => mock.close(r));
  if (home) await rm(home, { recursive: true, force: true });
});

test('启动含 confirm 的 Flow 运行至挂起，run.get 返回 waiting_input', async () => {
  requests = 0;
  await rpc('run.start', { id: 'gate-1', flow: 'gate', variables: { 任务: '发布' } });
  const job = await waitForWaiting('gate-1');
  assert.equal(job.status, 'waiting_input');
  const history = await rpc('run.history', { id: 'gate-1' });
  const pending = history.nodeRuns.at(-1);
  assert.equal(pending.status, 'running');
  assert.equal(pending.pendingInput.message, '请确认 发布 的准备结果。');
  assert.deepEqual(pending.pendingInput.options, ['通过', '退回']);
  assert.equal(requests, 1, 'confirm 不消耗模型调用');
});

test('respond 非法结果名被拒绝且保持等待', async () => {
  const history = await rpc('run.history', { id: 'gate-1' });
  const pending = history.nodeRuns.at(-1);
  await assert.rejects(
    () => rpc('run.respond', { id: 'gate-1', nodeRunId: pending.id, result: '不存在' }),
    /无效的确认结果/,
  );
  const job = await rpc('run.get', { id: 'gate-1' });
  assert.equal(job.status, 'waiting_input');
});

test('respond 退回：节点按该结果完成并续跑至再次挂起', async () => {
  const history = await rpc('run.history', { id: 'gate-1' });
  const pending = history.nodeRuns.at(-1);
  await rpc('run.respond', { id: 'gate-1', nodeRunId: pending.id, result: '退回' });
  const job = await waitForWaiting('gate-1');
  assert.equal(job.status, 'waiting_input');
  const after = await rpc('run.history', { id: 'gate-1' });
  const done = after.nodeRuns.find((n) => n.id === pending.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.outcome.result, '退回');
  assert.equal(after.nodeRuns.filter((n) => n.nodeRef === 'gate').length, 2, '确认节点被再次提问');
});

test('重复 respond 旧节点被拒绝', async () => {
  const history = await rpc('run.history', { id: 'gate-1' });
  const stale = history.nodeRuns.filter((n) => n.nodeRef === 'gate')[0];
  await assert.rejects(
    () => rpc('run.respond', { id: 'gate-1', nodeRunId: stale.id, result: '通过' }),
    /不在等待人工确认|只能应答/,
  );
});

test('respond 通过：沿结果边直达终态', async () => {
  const history = await rpc('run.history', { id: 'gate-1' });
  const pending = history.nodeRuns.at(-1);
  await rpc('run.respond', { id: 'gate-1', nodeRunId: pending.id, result: '通过' });
  const job = await waitFor('gate-1', 'completed');
  assert.equal(job.status, 'completed');
  const after = await rpc('run.history', { id: 'gate-1' });
  assert.equal(after.nodeRuns.filter((n) => n.nodeRef === 'gate').length, 2);
});

test('resume 挂起中的 Run 重新提问并再次挂起', async () => {
  requests = 0;
  await rpc('run.start', { id: 'gate-2', flow: 'gate', variables: { 任务: '上线' } });
  await waitForWaiting('gate-2');
  const before = await rpc('run.history', { id: 'gate-2' });
  const oldPending = before.nodeRuns.at(-1);
  await rpc('run.resume', { id: 'gate-2' });
  await until(async () => {
    const job = await rpc('run.get', { id: 'gate-2' });
    if (job.status !== 'waiting_input') return false;
    const history = await rpc('run.history', { id: 'gate-2' });
    const latest = history.nodeRuns.at(-1);
    return latest.id !== oldPending.id && latest.pendingInput && latest;
  });
  // 重新提问后仍可正常应答完成
  const history = await rpc('run.history', { id: 'gate-2' });
  const pending = history.nodeRuns.at(-1);
  await rpc('run.respond', { id: 'gate-2', nodeRunId: pending.id, result: '通过' });
  await waitFor('gate-2', 'completed');
});

test('等待状态下 stop 正常终止，取消后不可 respond', async () => {
  requests = 0;
  await rpc('run.start', { id: 'gate-3', flow: 'gate', variables: { 任务: '回滚' } });
  await waitForWaiting('gate-3');
  const job = await rpc('run.stop', { id: 'gate-3' });
  assert.equal(job.status, 'stopped');
  const history = await rpc('run.history', { id: 'gate-3' });
  const pending = history.nodeRuns.at(-1);
  await assert.rejects(
    () => rpc('run.respond', { id: 'gate-3', nodeRunId: pending.id, result: '通过' }),
    /只能应答等待人工确认的 Run/,
  );
});

test('非等待 Run 不可 respond', async () => {
  await assert.rejects(
    () => rpc('run.respond', { id: 'gate-1', nodeRunId: 'x', result: '通过' }),
    /只能应答等待人工确认的 Run/,
  );
});
