import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// 本地 OpenAI 兼容服务：第一次返回「已分析」，第二次返回「已完成」，不访问真实模型。
async function openaiFixture(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const turn = requests.length;
    const args =
      turn === 1
        ? { outcome: '已分析', variables: { 分析结论: '本地验收' } }
        : { outcome: '已完成' };
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
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

test('Pi SDK 执行器按 provider 配置运行完整示例', async (t) => {
  const { baseUrl, requests } = await openaiFixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'ursi-sdk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const history = join(dir, 'history.json');
  const result = await exec(
    process.execPath,
    [
      resolve('dist/cli.js'),
      'run',
      resolve('../flow-runtime/examples/ordinary'),
      '--cwd',
      dir,
      '--history',
      history,
      '--trajectories',
      join(dir, 'trajectories'),
      '--base-url',
      baseUrl,
      '--api-key',
      'fixture',
      '--model',
      'fixture',
    ],
    { env: { PATH: process.env.PATH, HOME: dir }, timeout: 60000 },
  ).catch((error) => {
    throw new Error(`${error.stdout} ${error.stderr}`);
  });
  assert.equal(JSON.parse(result.stdout).status, 'completed');
  assert.equal(requests.length, 2);
  // 节点既能读写工作区，也必须带上结果工具，且结果集合来自当前节点声明。
  const names = requests[0].tools.map((tool) => tool.function.name);
  for (const tool of ['read', 'bash', 'edit', 'write', 'submit_flow_outcome'])
    assert.ok(names.includes(tool), `缺少工具 ${tool}: ${names.join(',')}`);
  const outcome = requests[0].tools.find((tool) => tool.function.name === 'submit_flow_outcome');
  assert.ok(outcome.function.parameters.properties.outcome, JSON.stringify(outcome.function.parameters));
  assert.ok(requests[1].messages.some((message) => message.role === 'tool'));
  // 每个 Agent 节点执行留一份可被轨迹查看器解析的 JSONL 切片。
  const files = (await readdir(join(dir, 'trajectories'))).filter((name) => name.endsWith('.jsonl'));
  assert.ok(files.length >= 2, `应至少记录两次节点执行：${files.join(',')}`);
  for (const name of files) {
    const rows = (await readFile(join(dir, 'trajectories', name), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows[0].type, 'session', `${name} 缺少会话头`);
    assert.ok(rows.length > 1, `${name} 没有会话条目`);
    assert.equal(rows[0].id, name.replace(/\.jsonl$/, ''));
    assert.ok(
      rows.some((row) => row.type === 'message' && row.message?.role === 'user'),
      `${name} 没有用户消息`,
    );
  }
});

test('provider 配置不完整时给出可操作的错误', async () => {
  const { PiSdkHarness } = await import(resolve('dist/executor-adapters/local-pi/sdk.js'));
  assert.throws(
    () => new PiSdkHarness({ baseUrl: '', apiKey: 'k', model: 'm' }),
    /provider\.baseUrl 必须是非空字符串/,
  );
  assert.throws(
    () => new PiSdkHarness({ baseUrl: 'https://x', apiKey: 'k', model: 'm', api: 'nope' }),
    /provider\.api 只能是/,
  );
});
