import Ajv from 'ajv/dist/2020.js';

export const LEGACY_VERSION = '2025-06-18';
export const MODERN_VERSION = '2026-07-28';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const idSchema = { type: 'string', pattern: `^${uuid}$` };
const validId = new RegExp(idSchema.pattern);
export const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const only = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const codes = ['invalid', 'conflict', 'not_found', 'busy', 'unavailable'];
export class ExecutorError extends Error {
  constructor(code) {
    super(code);
    this.code = codes.includes(code) ? code : 'unavailable';
  }
}
export function parseAttemptRequest(value) {
  if (!isObject(value) || !only(value, ['attemptId']) || typeof value.attemptId !== 'string' || !validId.test(value.attemptId)) throw new ExecutorError('invalid');
  return { attemptId: value.attemptId };
}
export function parseStartRequest(value) {
  if (!isObject(value) || !only(value, ['attemptId', 'workspaceRef', 'artifactDirectoryRef', 'workInstruction', 'runConfig'])) throw new ExecutorError('invalid');
  const { attemptId, workspaceRef, artifactDirectoryRef, workInstruction, runConfig } = value;
  parseAttemptRequest({ attemptId });
  if (workspaceRef !== `workspace:${attemptId}` || artifactDirectoryRef !== `artifacts:${attemptId}` || typeof workInstruction !== 'string' || (runConfig !== undefined && !isObject(runConfig))) throw new ExecutorError('invalid');
  return { attemptId, workspaceRef, artifactDirectoryRef, workInstruction, ...(runConfig === undefined ? {} : { runConfig }) };
}

export function toolContract(schema = { type: 'object', additionalProperties: false }) {
  const runConfig = structuredClone(schema);
  if (!isObject(runConfig) || runConfig.type !== 'object' || runConfig.$async) throw new TypeError('Expected a synchronous object schema for runConfig');
  const validate = new Ajv({ ownProperties: true }).compile(runConfig);
  if (!validate({})) throw new TypeError('runConfig schema must accept the default {}');
  const identity = { type: 'object', additionalProperties: false, required: ['attemptId'], properties: { attemptId: idSchema } };
  const tools = [
    { name: 'executor_start', description: 'Start or retrieve an executor attempt.', inputSchema: {
      ...identity, required: ['attemptId', 'workspaceRef', 'artifactDirectoryRef', 'workInstruction'], properties: {
        attemptId: idSchema, workspaceRef: { type: 'string', pattern: `^workspace:${uuid}$` },
        artifactDirectoryRef: { type: 'string', pattern: `^artifacts:${uuid}$` }, workInstruction: { type: 'string' }, runConfig,
      },
    } },
    { name: 'executor_inspect', description: 'Inspect an executor attempt.', inputSchema: identity },
    { name: 'executor_cancel', description: 'Request cancellation of an executor attempt.', inputSchema: identity },
  ];
  return { tools, validate };
}

export function success(id, value) {
  if (!isObject(value) || value.attemptId !== id || value.artifactDirectoryRef !== `artifacts:${id}` || !['running', 'succeeded', 'failed', 'cancelled', 'unverified'].includes(value.status) || (value.backendRunRef !== undefined && typeof value.backendRunRef !== 'string')) throw new ExecutorError('unavailable');
  const result = { attemptId: id, status: value.status, artifactDirectoryRef: value.artifactDirectoryRef };
  if (value.backendRunRef !== undefined) result.backendRunRef = value.backendRunRef;
  return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
}
export function failure(error) {
  const code = error instanceof ExecutorError && codes.includes(error.code) ? error.code : 'unavailable';
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code }) }] };
}
