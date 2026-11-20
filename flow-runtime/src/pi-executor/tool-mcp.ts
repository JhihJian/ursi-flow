import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { authorize, loadPolicy, record, schemaDigest, type PolicyTool, type ToolRef } from './policy.ts';

const version = '2025-06-18';
const limit = 512 * 1024;
function denied(): never { throw new Error('Business tool unavailable'); }

// Deliberately support the single-JSON-response profile of Streamable HTTP.
// No redirects, proxies, cookies, SSE callbacks, or unbounded response.text().
async function post(endpoint: PolicyTool, message: object, headers: Record<string, string>, signal: AbortSignal) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  if (Buffer.byteLength(body) > limit) return denied();
  const url = new URL(endpoint.url);
  const send = url.protocol === 'https:' ? https : http;
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    send(url, {
      method: 'POST', agent: false, maxHeaderSize: 16 * 1024, signal,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}), ...headers },
    }, resolve).on('error', reject).end(body);
  });
  try {
    const isRequest = 'id' in message;
    if (response.statusCode !== (isRequest ? 200 : 202)) return denied();
    if (isRequest && response.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return denied();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > limit || (!isRequest && bytes)) return denied();
      chunks.push(chunk);
    }
    const value: unknown = isRequest ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) : null;
    if (isRequest && (!record(value) || value.jsonrpc !== '2.0' || value.id !== message.id || 'error' in value || !record(value.result))) return denied();
    return { result: record(value) ? value.result as Record<string, unknown> : {}, session: response.headers['mcp-session-id'] };
  } finally { response.destroy(); }
}

export async function callBusinessTool(path: string, ref: ToolRef, args: unknown, parent: AbortSignal) {
  try {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
    const endpoint = authorize(await loadPolicy(path), ref);
    const init = await post(endpoint, { id: 1, method: 'initialize', params: {
      protocolVersion: version, capabilities: {}, clientInfo: { name: 'ursi-pi', version: '1' },
    } }, {}, signal);
    if (init.result.protocolVersion !== version || !record(init.result.capabilities) || !record(init.result.capabilities.tools)) return denied();
    const headers: Record<string, string> = { 'mcp-protocol-version': version };
    if (init.session !== undefined) {
      if (typeof init.session !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(init.session)) return denied();
      headers['mcp-session-id'] = init.session;
    }
    await post(endpoint, { method: 'notifications/initialized' }, headers, signal);
    const { result: list } = await post(endpoint, { id: 2, method: 'tools/list', params: {} }, headers, signal);
    if (list.nextCursor !== undefined || !Array.isArray(list.tools) || list.tools.length > 256) return denied();
    const matches = list.tools.filter(item => record(item) && item.name === endpoint.name);
    if (matches.length !== 1 || !record(matches[0].inputSchema) || schemaDigest(matches[0].inputSchema) !== ref.schemaDigest ||
        (matches[0].annotations !== undefined && (!record(matches[0].annotations) ||
          (matches[0].annotations.readOnlyHint !== undefined && matches[0].annotations.readOnlyHint !== true)))) return denied();

    // Do not issue the business request if authorization or its destination changed during discovery.
    const current = authorize(await loadPolicy(path), ref);
    if (current.url !== endpoint.url || current.name !== endpoint.name || current.token !== endpoint.token) return denied();
    const { result } = await post(current, { id: 3, method: 'tools/call', params: { name: current.name, arguments: args } }, headers, signal);
    if ((result.isError !== undefined && result.isError !== false) || !Array.isArray(result.content)) return denied();
    const texts = result.content.map(item => {
      if (!record(item) || item.type !== 'text' || typeof item.text !== 'string') return denied();
      return item.text;
    });
    const text = texts.join('\n');
    if (!text || (endpoint.token && text.includes(endpoint.token)) || (init.session && text.includes(init.session))) return denied();
    return text;
  } catch { return denied(); }
}
