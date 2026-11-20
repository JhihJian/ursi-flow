import { createHash } from 'node:crypto';
import { validateProviderConfig, type PiProviderConfig } from '../executor-adapters/local-pi/sdk.ts';
import { openPolicyFile, readBounded } from './session-files.ts';

export interface ToolRef { id: string; schemaDigest: string }
export interface PolicyTool {
  id: string; url: string; name: string; inputSchema: Record<string, unknown>; readOnly: true; token?: string;
}
export interface Policy { models: { id: string; provider: PiProviderConfig }[]; tools: PolicyTool[] }
export const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
function deny(): never { throw new Error('Pi policy unavailable'); }

function canonical(v: unknown, depth = 0): string {
  if (depth > 64) return deny();
  if (Array.isArray(v)) return '[' + v.map(item => canonical(item, depth + 1)).join(',') + ']';
  // Serialize keys directly: stringify(object) reorders integer-like keys numerically.
  if (record(v)) return '{' + Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(k => JSON.stringify(k) + ':' + canonical(v[k], depth + 1)).join(',') + '}';
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return JSON.stringify(v);
  return deny();
}
export function schemaDigest(schema: Record<string, unknown>) {
  return createHash('sha256').update(canonical(schema)).digest('hex');
}

function endpoint(value: unknown): value is string {
  if (!nonempty(value) || /[?#\\\s]/.test(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password && (url.protocol === 'https:' ||
    (url.protocol === 'http:' && (/^127\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === '[::1]')));
}
function tool(v: unknown): v is PolicyTool {
  return record(v) && nonempty(v.id) && nonempty(v.name) && endpoint(v.url) && v.readOnly === true &&
    record(v.inputSchema) && v.inputSchema.type === 'object' &&
    (v.token === undefined || (nonempty(v.token) && /^[!-~]+$/.test(v.token)));
}

export async function loadPolicy(path: string): Promise<Policy> {
  try {
    const file = await openPolicyFile(path);
    try {
      const { uid, mode } = await file.stat();
      if ((uid !== 0 && uid !== process.geteuid?.()) || (mode & 0o7777) !== 0o600) return deny();
      const v: unknown = JSON.parse(await readBounded(file, 1024 * 1024));
      if (!record(v) || !Array.isArray(v.models) || !Array.isArray(v.tools)) return deny();
      const models = v.models.map(m => {
        if (!record(m) || !nonempty(m.id)) return deny();
        validateProviderConfig(m.provider);
        if (!endpoint(m.provider.baseUrl)) return deny();
        return { id: m.id, provider: m.provider };
      });
      if (!v.tools.every(tool) || [models, v.tools].some(rows => new Set(rows.map(row => row.id)).size !== rows.length)) return deny();
      return { models, tools: v.tools };
    } finally { await file.close(); }
  } catch { return deny(); }
}

export function authorize(policy: Policy, ref: ToolRef) {
  const item = policy.tools.find(t => t.id === ref.id);
  if (!item || !/^[a-f0-9]{64}$/.test(ref.schemaDigest) || schemaDigest(item.inputSchema) !== ref.schemaDigest) return deny();
  return item;
}
