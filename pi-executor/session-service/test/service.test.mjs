import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { test } from 'node:test';
import { startService } from '../src/server.mjs';
import { fakeProvider, model, modelKey } from './fake-provider.mjs';

const writer = 'test-writer-token-at-least-24';
const reader = 'test-reader-token-at-least-24';

async function observe(response, signal) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const decoder = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return {
    async until(predicate) {
      while (!signal.aborted) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!frame.startsWith('data: ')) continue;
          const snapshot = JSON.parse(frame.slice(6));
          if (predicate(snapshot)) return { snapshot, bytes: Buffer.byteLength(frame) };
        } else {
          const { done, value } = await decoder.read();
          assert.equal(done, false, 'event stream ended early');
          buffer += value;
        }
      }
      throw signal.reason;
    },
    close: () => decoder.cancel(),
  };
}

const text = message => message?.content?.find(block => block.type === 'text')?.text ?? '';

test('shared Pi session: viewer observes live and cold history without starting the model', { timeout: 20_000 }, async t => {
  const provider = await fakeProvider();
  const root = await mkdtemp(join(tmpdir(), 'ursi-pi-test-'));
  const reference = join(root, 'operator.txt');
  await writeFile(reference, 'reference result');
  const env = {
    PI_SESSION_PORT: '0', PI_SESSION_STATE_DIR: root, PI_SESSION_MODEL: model,
    PI_SESSION_MODEL_URL: provider.url, PI_SESSION_MODEL_KEY: modelKey,
    PI_SESSION_WRITE_TOKEN: writer, PI_SESSION_READ_TOKEN: reader, PI_SESSION_REFERENCE_FILE: reference,
  };
  let service;
  t.after(async () => {
    await service?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  service = await startService(env);
  await assert.rejects(startService(env), { code: 'EEXIST' });
  const signal = AbortSignal.timeout(15_000);
  function request(path, token, method = 'GET', body) {
    return fetch(`http://127.0.0.1:${service.server.address().port}/api/pi${path}`, {
      method, signal, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
    });
  }
  assert.equal((await request('/sessions')).status, 401);
  assert.deepEqual(await (await request('/access', reader)).json(), { canWrite: false });
  assert.deepEqual(await (await request('/access', writer)).json(), { canWrite: true });
  assert.equal((await request('/runtime')).status, 401);
  const runtime = await request('/runtime', reader);
  assert.equal(runtime.status, 200);
  assert.equal(runtime.headers.get('cache-control'), 'no-store');
  const configuration = await runtime.json();
  assert.deepEqual(configuration, {
    scope: 'service',
    systemPrompt: 'You are a helpful assistant.',
    model: { id: model, name: model, provider: 'ursi-session', contextWindow: 128_000, maxTokens: 8192 },
    tools: [{ name: 'read_reference', description: 'Read the reference material provided by the operator.', parameters: { type: 'object', properties: {} }, active: true }],
    skills: [], mcp: [],
  });
  assert.deepEqual(await (await request('/runtime', writer)).json(), configuration);
  assert.equal(provider.requests.length, 0);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.jsonl')), []);
  assert.equal((await request('/sessions', reader, 'POST', {})).status, 403);
  const created = await request('/sessions', writer, 'POST', { title: 'External run' });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const session = `/sessions/${id}`;
  assert.deepEqual(await (await request(`${session}/runtime`, reader)).json(), configuration);
  assert.equal((await request(`${session}/runtime`)).status, 401);
  const before = await observe(await request(`${session}/events`, reader), signal);
  assert.equal((await before.until(data => data.status === 'idle')).snapshot.id, id);
  await before.close();
  assert.equal(provider.requests.length, 0);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.jsonl')), []);

  const message = 'use reference ' + '任务'.repeat(9000).slice(0, 11_000);
  assert.equal((await request(`${session}/prompt`, writer, 'POST', { message })).status, 202);
  await t.waitFor(() => assert.equal(provider.requests.length, 2));
  assert.ok(provider.requests[0].body.tools.some(tool => tool.function.name === 'read_reference'));
  assert.ok(provider.requests[0].body.messages.some(entry => entry.role === 'system' && entry.content.includes(configuration.systemPrompt)));
  assert.equal(provider.requests[0].body.model, configuration.model.id);
  assert.deepEqual(provider.requests[0].body.tools.map(tool => tool.function.name), ['read_reference']);
  const sentPrompt = provider.requests[0].body.messages.find(entry => entry.role === 'system').content;
  const expectedRuntime = {
    ...configuration, scope: 'session', systemPrompt: sentPrompt.replaceAll(join(root, 'workspace'), '[workspace]'),
  };
  assert.deepEqual(await (await request(`${session}/runtime`, reader)).json(), expectedRuntime);
  const midflight = await observe(await request(`${session}/events`, reader), signal);
  const first = await midflight.until(data => text(data.partial).includes('第一段输出'));
  assert.ok(first.bytes > 32_000, 'SSE snapshot exercises socket backpressure');
  assert.equal(first.snapshot.status, 'running');
  assert.equal(text(first.snapshot.messages[0]), message);
  assert.ok(first.snapshot.messages.some(item => item.role === 'toolResult' && text(item) === 'reference result'));
  assert.equal((await request(`${session}/prompt`, reader, 'POST', { message: 'ignored' })).status, 403);
  assert.equal((await request(`${session}/cancel`, reader, 'POST')).status, 403);
  assert.equal((await request(`${session}/prompt`, writer, 'POST', { message: 'conflict' })).status, 409);
  await midflight.close();
  const reconnected = await observe(await request(`${session}/events`, reader), signal);
  await reconnected.until(data => text(data.partial).includes('第一段输出'));
  assert.equal(provider.requests.length, 2);
  provider.requests[1].finish();
  const finished = (await reconnected.until(data => data.status === 'completed')).snapshot;
  assert.equal(text(finished.messages.at(-1)), '第一段输出。第二段输出。');
  const effective = await (await request(`${session}/runtime`, reader)).json();
  assert.deepEqual(effective, expectedRuntime);
  assert.equal(provider.requests.length, 2);
  await reconnected.close();

  await service.close();
  const file = (await readdir(root)).find(name => name.endsWith('.jsonl'));
  assert.ok(file);
  const history = await readFile(join(root, file), 'utf8');
  assert.equal(JSON.parse(history.split('\n')[0]).id, id);
  service = await startService(env);
  assert.deepEqual(await (await request(session, reader)).json(), finished);
  assert.deepEqual(await (await request(`${session}/runtime`, reader)).json(), effective);
  const restored = await observe(await request(`${session}/events`, reader), signal);
  assert.deepEqual((await restored.until(data => data.status === 'completed')).snapshot, finished);
  assert.equal(await readFile(join(root, file), 'utf8'), history);
  assert.equal(provider.requests.length, 2);

  assert.equal((await request(`${session}/prompt`, writer, 'POST', { message: 'follow-up' })).status, 202);
  await t.waitFor(() => assert.equal(provider.requests.length, 3));
  assert.ok(provider.requests[2].body.messages.some(entry => entry.role === 'assistant' && entry.content === '第一段输出。第二段输出。'));
  assert.equal((await request(`${session}/cancel`, writer, 'POST')).status, 202);
  await restored.until(data => data.status === 'cancelled');
  await t.waitFor(() => assert.equal(provider.requests[2].closed, true));
  await restored.close();
  assert.equal((await request(`${session}/cancel`, writer, 'POST')).status, 409);
  assert.equal(provider.requests.length, 3);
});

for (const role of ['read', 'write']) {
  test(`token-free Web access is restricted to the configured origin and role: ${role}`, async t => {
    const provider = await fakeProvider();
    const root = await mkdtemp(join(tmpdir(), 'ursi-pi-web-test-'));
    const origin = 'http://pi.example.test';
    const env = {
      PI_SESSION_PORT: '0', PI_SESSION_STATE_DIR: root, PI_SESSION_MODEL: model,
      PI_SESSION_MODEL_URL: provider.url, PI_SESSION_MODEL_KEY: modelKey,
      PI_SESSION_WEB_ORIGIN: origin, PI_SESSION_WEB_ACCESS: role,
      ...(role === 'write' && { PI_SESSION_WRITE_TOKEN: writer, PI_SESSION_READ_TOKEN: reader }),
    };
    let service;
    t.after(async () => {
      await service?.close();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    });
    await assert.rejects(startService({ ...env, PI_SESSION_WEB_ACCESS: '' }), /PI_SESSION_WEB_ACCESS/);
    service = await startService(env);
    const base = `http://127.0.0.1:${service.server.address().port}/api/pi`;
    const signal = AbortSignal.timeout(10_000);
    const request = (path, { method, headers, body } = {}) => new Promise((resolve, reject) => {
      const req = httpRequest(`${base}${path}`, {
        signal, method, headers: { host: 'pi.example.test', 'x-pi-web': '1', ...headers },
      }, res => resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers })));
      req.on('error', reject);
      req.end(body);
    });
    const create = headers => request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: '{}',
    });
    assert.equal((await request('/access', { headers: { host: 'external.example.test' } })).status, 401);
    assert.equal((await request('/sessions', { headers: { 'x-pi-web': '' } })).status, 401);
    assert.equal((await request('/access', { headers: { authorization: '' } })).status, 401);
    assert.equal((await request('/access', { headers: { authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await request('/access', { headers: { authorization: [`Bearer ${writer}`, `Bearer ${reader}`] } })).status, 401);
    assert.deepEqual(await (await request('/access')).json(), { canWrite: role === 'write' });
    assert.deepEqual((await (await request('/runtime')).json()).tools, []);
    assert.equal((await request('/runtime', { headers: { origin: 'https://other.example.test' } })).status, 403);
    assert.equal((await request('/runtime', { headers: { authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await request('/sessions', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
    assert.equal((await create({ origin: 'https://other.example.test' })).status, 403);
    assert.equal((await create({ origin: 'null' })).status, 403);
    assert.equal((await request('/sessions', { method: 'POST' })).status, 403);
    assert.deepEqual(await (await request('/sessions')).json(), { sessions: [] });
    if (role === 'read') {
      assert.equal((await create()).status, 403);
      assert.equal((await create({ authorization: `Bearer ${writer}` })).status, 401);
    } else {
      assert.equal((await create({ authorization: `Bearer ${reader}` })).status, 403);
      const created = await create();
      assert.equal(created.status, 201);
      const { id } = await created.json();
      const session = `/sessions/${id}`;
      const watcher = await observe(await request(`${session}/events`), signal);
      await watcher.until(data => data.status === 'idle');
      await watcher.close();
      assert.equal(provider.requests.length, 0);
      assert.equal((await request(`${session}/prompt`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{"message":"hello"}',
      })).status, 202);
      await t.waitFor(() => assert.equal(provider.requests.length, 1));
      assert.equal((await request(`${session}/cancel`, {
        method: 'POST', headers: { origin: 'http://other.example.test' },
      })).status, 403);
      assert.equal((await (await request(session)).json()).status, 'running');
      assert.equal((await request(`${session}/cancel`, { method: 'POST', headers: { origin } })).status, 202);
    }
    assert.equal(provider.requests.length, role === 'write' ? 1 : 0);
  });
}
