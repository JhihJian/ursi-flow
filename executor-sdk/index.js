import { once } from 'node:events';
import { LEGACY_VERSION, MODERN_VERSION, ExecutorError, parseStartRequest, parseAttemptRequest, isObject, only, toolContract, success, failure } from './protocol.js';
export { ExecutorError, LEGACY_VERSION, MODERN_VERSION, parseStartRequest, parseAttemptRequest };

const versions = [MODERN_VERSION, LEGACY_VERSION];
const versionKey = 'io.modelcontextprotocol/protocolVersion';
const capsKey = 'io.modelcontextprotocol/clientCapabilities';
const invalidParams = id => error(id, -32602, 'Invalid params');
const error = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
const identity = info => isObject(info) && typeof info.name === 'string' && typeof info.version === 'string';

export function createExecutorServer(options) {
  if (!identity(options) || !['start','inspect','cancel'].every(k => typeof options[k] === 'function')) throw new TypeError('Expected name, version, start, inspect and cancel');
  const info = { name: options.name, version: options.version };
  const { tools, validate } = toolContract(options.runConfigSchema);
  let legacy = 'new';
  return { async handle(req) {
    if (!isObject(req) || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return error(null, -32600, 'Invalid Request');
    const { id, method, params = {} } = req;
    if (id === undefined) {
      if (method === 'notifications/initialized' && legacy === 'initializing') legacy = 'ready';
      return;
    }
    if (typeof id !== 'string' && !Number.isSafeInteger(id)) return error(null, -32600, 'Invalid Request');
    if (!isObject(params) || (params._meta !== undefined && !isObject(params._meta))) return invalidParams(id);
    const requested = params._meta?.[versionKey];
    const modern = requested !== undefined || method === 'server/discover';
    const reply = result => ({ jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result } : result });
    if (modern) {
      if (typeof requested !== 'string') return invalidParams(id);
      if (requested !== MODERN_VERSION) return error(id, -32022, 'Unsupported protocol version', { supported: versions, requested });
      if (!isObject(params._meta?.[capsKey])) return invalidParams(id);
      if (method === 'server/discover') return only(params, ['_meta']) ? reply({
        supportedVersions: versions, capabilities: { tools: {} },
        ttlMs: 0, cacheScope: 'private',
        _meta: { 'io.modelcontextprotocol/serverInfo': info, 'ursi/executorProtocol': '1' },
      }) : invalidParams(id);
    } else if (method === 'initialize') {
      if (legacy !== 'new' || params.protocolVersion !== LEGACY_VERSION || !identity(params.clientInfo) || !isObject(params.capabilities)) return invalidParams(id);
      legacy = 'initializing';
      return reply({ protocolVersion: LEGACY_VERSION, capabilities: { tools: {} }, serverInfo: info });
    } else if (legacy !== 'ready') return error(id, -32002, 'Server not initialized');
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return only(params, ['_meta']) ? reply({ tools }) : invalidParams(id);
    if (method !== 'tools/call') return error(id, -32601, 'Method not found');
    if (!only(params, ['name', 'arguments', '_meta']) || typeof params.name !== 'string') return invalidParams(id);
    try {
      let args, value;
      switch (params.name) {
        case 'executor_start':
          args = parseStartRequest(params.arguments);
          if (!validate(args.runConfig ?? {})) throw new ExecutorError('invalid');
          value = await options.start(args);
          break;
        case 'executor_inspect': case 'executor_cancel':
          args = parseAttemptRequest(params.arguments);
          value = await options[params.name === 'executor_inspect' ? 'inspect' : 'cancel'](args);
          break;
        default: throw new ExecutorError('invalid');
      }
      return reply(success(args.attemptId, value));
    } catch (err) { return reply(failure(err)); }
  } };
}

const frameLimit = 4 * 1024 * 1024;
export async function runStdio(input, output, server) {
  const send = async reply => {
    if (reply === undefined) return;
    let line = JSON.stringify(reply) + '\n';
    if (Buffer.byteLength(line) > frameLimit) line = JSON.stringify(error(reply.id, -32603, 'Response too large')) + '\n';
    if (!output.write(line)) await once(output, 'drain');
  };
  let parts = [], size = 0;
  // Discard an oversized line incrementally, including when the sender never emits LF.
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start);
      const part = bytes.subarray(start, end < 0 ? bytes.length : end);
      size += part.length;
      if (size < frameLimit) parts.push(part); else parts.length = 0;
      if (end < 0) break;
      if (size >= frameLimit) await send(error(null, -32600, 'Request too large'));
      else if (size) {
        let request;
        try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, size))); }
        catch { await send(error(null, -32700, 'Parse error')); }
        if (request !== undefined) await send(await server.handle(request));
      }
      parts = []; size = 0; start = end + 1;
    }
  }
}
export function serveExecutor(options) {
  return runStdio(process.stdin, process.stdout, createExecutorServer(options));
}
