import { ExecutorError } from 'ursi-executor-sdk';
import { isRecord, validateVariableName } from '../core/contracts/variables.ts';

export interface NodeContract { outcomes: string[]; variables: string[] }
const names = { type: 'array', uniqueItems: true, maxItems: 256, items: { type: 'string', pattern: '\\S' } };
export const runConfigSchema = {
  type: 'object', additionalProperties: false, properties: {
    nodeContract: {
      type: 'object', required: ['outcomes', 'variables'], additionalProperties: false,
      properties: { outcomes: { ...names, minItems: 1 }, variables: names },
    },
  },
};

function nameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= names.maxItems && new Set(value).size === value.length &&
    value.every(item => typeof item === 'string' && item.trim());
}

export function parseRunConfig(value: unknown = {}): NodeContract | undefined {
  if (!isRecord(value)) throw new ExecutorError('invalid');
  if (!Object.keys(value).length) return;
  const c = value.nodeContract;
  if (Object.keys(value).length !== 1 || !isRecord(c) || Object.keys(c).length !== 2 ||
    !nameList(c.outcomes) || !c.outcomes.length || !nameList(c.variables)) throw new ExecutorError('invalid');
  try { c.variables.forEach(validateVariableName); } catch { throw new ExecutorError('invalid'); }
  // Fix object key order for the attempt identity; declaration order is significant.
  return { outcomes: [...c.outcomes], variables: [...c.variables] };
}
