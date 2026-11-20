import type { FileHandle } from 'node:fs/promises';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { authorize, record, type Policy, type ToolRef } from './policy.ts';
import { listInputs, readInput } from './session-files.ts';
import { callBusinessTool } from './tool-mcp.ts';

export function sessionTools(workspace: FileHandle, policyPath: string, policy: Policy, refs: ToolRef[], signal: AbortSignal): ToolDefinition[] {
  function definition(name: string, description: string, schema: Record<string, unknown>,
    run: (params: Record<string, unknown>, signal: AbortSignal) => Promise<string>): ToolDefinition {
    return {
      name, label: name, description, parameters: Type.Unsafe<Record<string, unknown>>(schema), executionMode: 'sequential',
      async execute(_id, params, toolSignal) {
        const active = toolSignal ? AbortSignal.any([toolSignal, signal]) : signal;
        try {
          active.throwIfAborted();
          if (!record(params)) throw new Error('Invalid tool arguments');
          const text = await run(params, active);
          active.throwIfAborted();
          return { content: [{ type: 'text', text }], details: {} };
        } catch { throw new Error('Tool unavailable'); }
      },
    };
  }
  const path = { type: 'object', properties: { path: { type: 'string', maxLength: 4096 } }, additionalProperties: false };
  return [
    definition('list_inputs', 'List files in inputs/ or in one relative subdirectory.', path,
      args => listInputs(workspace, String(args.path ?? ''))),
    definition('read_input', 'Read a UTF-8 text file by path relative to inputs/.', { ...path, required: ['path'] },
      args => readInput(workspace, String(args.path))),
    ...refs.map((ref, i) => {
      const { inputSchema } = authorize(policy, ref);
      // Arbitrary catalog IDs cannot alias Pi builtins or become tool-selection patterns.
      return definition(`business_${i + 1}`, `Call authorized read-only business tool ${ref.id}.`, inputSchema,
        (params, active) => callBusinessTool(policyPath, ref, params, active));
    }),
  ];
}
