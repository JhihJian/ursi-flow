import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createExecutorServer } from 'ursi-executor-sdk';

const attemptId = '123e4567-e89b-12d3-a456-426614174000';
const args = { attemptId, workspaceRef: `workspace:${attemptId}`, artifactDirectoryRef: `artifacts:${attemptId}`, workInstruction: '审查材料' };
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const request = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
const call = (name, args) => request('tools/call', { _meta: meta, name: `executor_${name}`, arguments: args });

test('independent backend: discover, validate, retry, inspect and cancel over separate stdio processes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'executor-sdk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function rpc(frame) {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('report.mjs', import.meta.url))], {
      env: { ...process.env, REPORT_DB: join(dir, 'jobs.sqlite') }, input: JSON.stringify(frame) + '\n', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  }
  const discovery = rpc(request('server/discover', { _meta: meta })).result;
  assert.deepEqual(discovery._meta, { 'ursi/executorProtocol': '1', 'io.modelcontextprotocol/serverInfo': { name: 'report', version: '1.2.3' } });
  assert.equal(discovery.resultType, 'complete');
  assert.equal(rpc(request('server/discover', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': 'unknown' } })).error.code, -32022);
  assert.equal(rpc(request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } })).error.code, -32602);
  const tools = rpc(request('tools/list', { _meta: meta })).result.tools;
  assert.deepEqual(tools[0].inputSchema.properties.runConfig.properties.format.enum, ['text', 'markdown']);
  const code = frame => JSON.parse(rpc(frame).result.content[0].text).code;
  assert.equal(code(call('start', { ...args, runConfig: { format: 'pdf' } })), 'invalid');
  assert.equal(code(call('inspect', { attemptId })), 'not_found');
  const start = call('start', { ...args, runConfig: { format: 'markdown' } });
  assert.equal(rpc(start).result.structuredContent.status, 'running');
  assert.equal(code(call('start', args)), 'conflict');
  assert.equal(rpc(call('cancel', { attemptId })).result.structuredContent.status, 'cancelled');
  assert.equal(rpc(start).result.structuredContent.status, 'cancelled');
  assert.equal(rpc(call('inspect', { attemptId })).result.structuredContent.status, 'cancelled');
});

test('malformed results and unexpected backend exceptions do not expose backend data', async () => {
  const server = createExecutorServer({ name: 'bad', version: '1', start() { throw new Error('private'); }, inspect() { return { attemptId: 'wrong' }; }, cancel() {} });
  for (const frame of [call('start', args), call('inspect', {attemptId})]) {
    const { result } = await server.handle(frame);
    assert.deepEqual(result, { resultType: 'complete', isError: true, content: [{ type: 'text', text: '{"code":"unavailable"}' }] });
  }
});
