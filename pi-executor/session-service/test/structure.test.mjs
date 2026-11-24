import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { startService } from '../src/server.mjs';
import { createSessions } from '../src/sessions.mjs';
import { fakeProvider, model, modelKey } from './fake-provider.mjs';

const writer = 'test-writer-token-at-least-24';
const reader = 'test-reader-token-at-least-24';
const user = content => ({ role: 'user', content, timestamp: 1 });

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'ursi-pi-structure-'));
  const provider = await fakeProvider();
  const env = {
    PI_SESSION_PORT: '0', PI_SESSION_STATE_DIR: root, PI_SESSION_MODEL: model,
    PI_SESSION_MODEL_URL: provider.url, PI_SESSION_MODEL_KEY: modelKey,
    PI_SESSION_WRITE_TOKEN: writer, PI_SESSION_READ_TOKEN: reader,
  };
  let service;
  t.after(async () => {
    await service?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  const restart = async () => { await service?.close(); service = await startService(env); };
  await restart();
  const signal = AbortSignal.timeout(12_000);
  async function request(path, { token = reader, body, status = 200 } = {}) {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/api/pi/sessions${path}`, {
      signal, method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  const create = title => request('', { token: writer, body: { title }, status: 201 });
  const write = (path, body, status) => request(path, { token: writer, body, status });
  async function observe(path, callback) {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/api/pi/sessions${path}/events`, {
      signal, headers: { authorization: `Bearer ${reader}` },
    });
    assert.equal(response.status, 200);
    const stream = response.body.pipeThrough(new TextDecoderStream());
    let buffer = '';
    for await (const chunk of stream) {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n\n')) !== -1;) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith('data: ')) {
          const snapshot = JSON.parse(frame.slice(6));
          assert.equal(snapshot.entryIds.length, snapshot.messages.length);
          if (callback(snapshot)) return snapshot;
        }
      }
    }
    assert.fail('Event stream ended before matching snapshot');
  }
  return { root, provider, restart, request, create, write, observe };
}

test('projects the SDK tree, previews an inactive path, and persists an explicit fork', { timeout: 15_000 }, async t => {
  const { root, provider, restart, request, create, write } = await harness(t);
  const { id } = await create('Source');
  const path = `/${id}`;
  assert.deepEqual(await request(`${path}/structure`), { activeLeafId: null, nodes: [], forkedFrom: null, forks: [] });
  assert.deepEqual((await request(path)).entryIds, []);
  await write(`${path}/fork`, { entryId: 'missing' }, 404);

  const cwd = join(root, 'workspace');
  const sdk = SessionManager.create(cwd, root, { id });
  sdk.appendThinkingLevelChange('off');
  const first = sdk.appendMessage(user(`root ${modelKey}`));
  const privateEntry = sdk.appendCustomEntry('private', { secret: 'must not surface' });
  sdk.appendLabelChange(first, 'label on retained path');
  const left = sdk.appendMessage(user('left branch'));
  sdk.branch(first);
  sdk.appendCustomMessageEntry('private', 'not public', false);
  const right = sdk.appendMessage(user('right branch'));
  const label = sdk.appendLabelChange(right, 'also private');
  const journal = join(root, `${id}.jsonl`);
  await rename(sdk.getSessionFile(), journal);
  const original = await readFile(journal, 'utf8');

  const active = await request(path);
  assert.deepEqual(active.entryIds, [first, right]);
  assert.deepEqual(await request(`${path}/structure`), {
    activeLeafId: right,
    nodes: [
      { id: first, parentId: null, role: 'user', text: 'root [redacted]' },
      { id: left, parentId: first, role: 'user', text: 'left branch' },
      { id: right, parentId: first, role: 'user', text: 'right branch' },
    ],
    forkedFrom: null, forks: [],
  });
  const preview = await request(`${path}?entry=${left}`);
  assert.deepEqual(preview.entryIds, [first, left]);
  assert.equal(preview.messages.at(-1).content[0].text, 'left branch');
  assert.deepEqual(await request(path), active);
  for (const entryId of [privateEntry, label, 'not-in-this-session']) {
    await request(`${path}?entry=${entryId}`, { status: 404 });
    await write(`${path}/fork`, { entryId }, 404);
  }
  await request(`${path}?entry=`, { status: 400 });
  await request(`${path}?entry=${left}&entry=${right}`, { status: 400 });
  await request(`${path}/fork`, { body: { entryId: left }, status: 403 });
  await write(`${path}/fork`, { entryId: left, prompt: 'do not run' }, 400);
  assert.equal(await readFile(journal, 'utf8'), original);

  const child = await write(`${path}/fork`, { entryId: left }, 201);
  assert.notEqual(child.id, id);
  assert.equal(child.status, 'idle');
  assert.equal(provider.requests.length, 0);
  const childPath = `/${child.id}`;
  const childSnapshot = await request(childPath);
  assert.deepEqual(childSnapshot, { ...preview, ...child });
  const childStructure = await request(`${childPath}/structure`);
  assert.equal(childStructure.activeLeafId, left);
  assert.deepEqual(childStructure.forkedFrom, { sessionId: id, entryId: left });
  assert.deepEqual(childStructure.nodes.map(node => node.id), [first, left]);
  const sourceStructure = await request(`${path}/structure`);
  assert.equal(sourceStructure.activeLeafId, right);
  assert.deepEqual(sourceStructure.forks, [{ sessionId: child.id, entryId: left, title: child.title }]);
  assert.equal(await readFile(journal, 'utf8'), original);

  const meta = JSON.parse(await readFile(join(root, `${child.id}.json`), 'utf8'));
  const forkFile = join(root, meta.file);
  assert.equal(JSON.parse((await readFile(forkFile, 'utf8')).split('\n')[0]).parentSession, journal);
  assert.equal((await stat(forkFile)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, `${child.id}.json`))).mode & 0o777, 0o600);
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.fork-') || name.endsWith('.tmp')));

  await restart();
  assert.deepEqual(await request(path), active);
  assert.deepEqual(await request(childPath), childSnapshot);
  assert.deepEqual(await request(`${path}/structure`), sourceStructure);
  assert.deepEqual(await request(`${childPath}/structure`), childStructure);
  assert.equal(provider.requests.length, 0);
  await write(`${childPath}/prompt`, { message: 'continue child' }, 202);
  await t.waitFor(() => assert.equal(provider.requests.length, 1));
  const context = JSON.stringify(provider.requests[0].body.messages);
  assert.match(context, /left branch/);
  assert.doesNotMatch(context, /right branch/);
  provider.requests[0].finish();
  await t.waitFor(async () => assert.equal((await request(childPath)).status, 'completed'));
  assert.deepEqual(await request(path), active);
});

test('live SSE IDs match the journal after cancellation and restart', { timeout: 15_000 }, async t => {
  const { root, provider, restart, request, create, write, observe } = await harness(t);
  const { id } = await create('Live source');
  const path = `/${id}`;
  await write(`${path}/prompt`, { message: 'live prompt' }, 202);
  await t.waitFor(() => assert.equal(provider.requests.length, 1));
  const live = await observe(path, snapshot => snapshot.partial !== null);
  const [entryId] = live.entryIds;
  assert.ok(entryId);
  assert.equal(live.messages.length, 1);
  assert.deepEqual(await request(`${path}/structure`), {
    activeLeafId: entryId,
    nodes: [{ id: entryId, parentId: null, role: 'user', text: 'live prompt' }],
    forkedFrom: null, forks: [],
  });
  const preview = await request(`${path}?entry=${entryId}`);
  assert.deepEqual(preview.entryIds, live.entryIds);
  assert.equal(preview.partial, null);
  assert.equal(preview.activeTool, null);
  assert.ok((await request(path)).partial);
  await write(`${path}/fork`, { entryId }, 409);
  await write(`${path}/cancel`, {}, 202);
  const cancelled = await observe(path, snapshot => snapshot.status === 'cancelled');
  assert.equal(cancelled.entryIds[0], entryId);
  const { file } = JSON.parse(await readFile(join(root, `${id}.json`), 'utf8'));
  const sdk = SessionManager.open(join(root, file), root);
  assert.deepEqual(cancelled.entryIds, sdk.getBranch().filter(entry => entry.type === 'message' && ['user', 'assistant', 'toolResult'].includes(entry.message.role)).map(entry => entry.id));
  await restart();
  assert.deepEqual(await request(path), cancelled);
  assert.equal(provider.requests.length, 1);
});

test('fork locking and the snapshot history cap preserve addressability without opening an Agent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ursi-pi-fork-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let opened = 0;
  const sessions = createSessions({ root, cwd: root, apiKey: modelKey, openPi() { opened++; throw new Error('unexpected Agent'); } });
  const { id } = await sessions.create('Long history');
  const sdk = SessionManager.create(root, root, { id });
  const ids = Array.from({ length: 105 }, (_, i) => sdk.appendMessage(user(`message ${i}`)));
  await rename(sdk.getSessionFile(), join(root, `${id}.jsonl`));

  const fork = sessions.fork(id, ids[0]);
  await assert.rejects(sessions.fork(id, ids[1]), { status: 409 });
  await assert.rejects(sessions.prompt(id, 'conflict'), { status: 409 });
  const child = await fork;
  const another = await sessions.fork(id, ids[0]);
  assert.notEqual(child.id, another.id);
  assert.deepEqual((await sessions.snapshot(child.id)).entryIds, ids.slice(0, 1));
  assert.deepEqual((await sessions.snapshot(id)).entryIds, ids.slice(-100));
  assert.deepEqual((await sessions.snapshot(id, ids[0])).entryIds, ids.slice(0, 1));
  const structure = await sessions.structure(id);
  assert.deepEqual(structure.nodes.map(node => node.id), ids);
  assert.deepEqual(structure.forks.map(item => item.sessionId), [child.id, another.id]);
  assert.equal(opened, 0);
});

test('an explicit tool-result-only fork is stored even when the SDK defers its journal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ursi-pi-tool-fork-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root, cwd: root, apiKey: modelKey, openPi: () => assert.fail('should not open an Agent') };
  const sessions = createSessions(options);
  const { id } = await sessions.create('Tool only');
  const sdk = SessionManager.inMemory(root, { id });
  const entryId = sdk.appendMessage({ role: 'toolResult', toolCallId: 'tool', toolName: 'lookup', content: [], timestamp: 1 });
  const journal = [sdk.getHeader(), ...sdk.getEntries()].map(entry => `${JSON.stringify(entry)}\n`).join('');
  await writeFile(join(root, `${id}.jsonl`), journal);

  const child = await sessions.fork(id, entryId);
  const restored = createSessions(options);
  await restored.restore();
  assert.deepEqual((await restored.snapshot(child.id)).entryIds, [entryId]);
  assert.deepEqual((await restored.structure(child.id)).forkedFrom, { sessionId: id, entryId });
  assert.equal((await restored.structure(id)).forks[0].sessionId, child.id);
});
