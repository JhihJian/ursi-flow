import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { PiProviderConfig } from '../executor-adapters/local-pi/sdk.ts';
import { parseConfig } from './files.ts';
import { loadPolicy, type ToolRef } from './policy.ts';
import { resources } from './resources.ts';
import { RuntimeOutcomeBridge } from '../ability/runtime-tools/bridge.ts';
import type { NodeContract } from './node-contract.ts';
import { openWorkspace, publishAnswer, publishArtifact } from './session-files.ts';
import { sessionTools } from './tools.ts';

export interface PiConfig {
  systemPrompt: string;
  modelProfile: string;
  skills: { id: string; revision: number; content: string }[];
  tools: ToolRef[];
}

async function createModel(p: PiProviderConfig, signal: AbortSignal) {
  const id = 'ursi-managed';
  const runtime = await ModelRuntime.create({
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, signal,
    // Supply the literal credential. Pi's provider config API also accepts env/command expressions.
    credentials: {
      async read(provider) { return provider === id ? { type: 'api_key', key: p.apiKey } : undefined; },
      async list() { return [{ providerId: id, type: 'api_key' }]; },
      async modify() { throw new Error('Read-only credential'); },
      async delete() { throw new Error('Read-only credential'); },
    },
  });
  const api = p.api ?? 'openai-completions';
  runtime.registerProvider(id, { name: 'Managed model', baseUrl: p.baseUrl, api, models: [{
    id: p.model, name: p.model, api, reasoning: p.reasoning ?? false, input: ['text'],
    contextWindow: p.contextWindow ?? 128000, maxTokens: p.maxTokens ?? 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }] });
  const model = runtime.getModel(id, p.model);
  if (!model) throw new Error('Model unavailable');
  return { model, modelRuntime: runtime };
}

export async function runPi(config: PiConfig, workspace: string, instruction: string, signal: AbortSignal, nodeContract?: NodeContract): Promise<void> {
  try {
    signal.throwIfAborted();
    // Project the frozen fields into fresh arrays before the first await.
    config = parseConfig(config);
    const flow = nodeContract && new RuntimeOutcomeBridge(workspace,
      nodeContract.outcomes.map(name => ({ name, description: '' })),
      new Map(nodeContract.outcomes.map(name => [name, nodeContract.variables])));
    const path = process.env.URSI_PI_POLICY;
    if (!path || path.startsWith(workspace + '/') || !instruction.trim() || Buffer.byteLength(instruction) > 256 * 1024)
      throw new Error('Invalid Pi configuration');
    const policy = await loadPolicy(path);
    const provider = policy.models.find(m => m.id === config.modelProfile)?.provider;
    if (!provider) throw new Error('Unknown model profile');
    const root = await openWorkspace(workspace);
    try {
      const tools = sessionTools(root, path, policy, config.tools, signal, flow);
      const { session } = await createAgentSession({
        cwd: workspace, agentDir: workspace, ...await createModel(provider, signal), thinkingLevel: provider.thinkingLevel ?? 'off',
        tools: tools.map(t => t.name), noTools: 'builtin', customTools: tools,
        sessionManager: SessionManager.inMemory(workspace), settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off',
        }), resourceLoader: resources(config),
      });
      const abort = () => { void session.abort().catch(() => {}); };
      let toolFailed = false;
      const unsubscribe = session.subscribe(event => {
        if (event.type === 'tool_execution_end' && event.isError) { toolFailed = true; abort(); }
        // An abort while prompt() is checking auth precedes the SDK's active agent controller.
        if (event.type === 'agent_start' && signal.aborted) abort();
      });
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        await session.prompt(instruction, { expandPromptTemplates: false });
        const last = session.messages.at(-1);
        if (last?.role === 'assistant' && last.stopReason === 'aborted') signal.throwIfAborted();
        if (toolFailed || last?.role !== 'assistant' || last.stopReason !== 'stop' || last.content.some(c => c.type === 'toolCall'))
          throw new Error('Incomplete Pi response');
        const answer = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        const checkSecrets = (text: string) => {
          if (text.includes(provider.apiKey) || policy.tools.some(t => t.token && text.includes(t.token))) throw new Error('Invalid result');
        };
        checkSecrets(answer);
        signal.throwIfAborted();
        if (flow) {
          const accepted = flow.outcome;
          if (!accepted) throw new Error('Missing Flow outcome');
          const json = JSON.stringify({ outcome: accepted.result, variables: accepted.variables ?? {} }, (key, value) => {
            checkSecrets(key);
            if (typeof value === 'string') checkSecrets(value);
            return value;
          });
          await publishArtifact(root, 'flow-outcome.json', json, signal);
        } else await publishAnswer(root, answer, signal);
      } finally {
        signal.removeEventListener('abort', abort);
        flow?.close();
        unsubscribe();
        session.dispose();
      }
    } finally { await root.close(); }
  } catch (error) {
    if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))) throw new DOMException('Pi run cancelled', 'AbortError');
    // SDK, filesystem and remote diagnostics can contain paths, prompts or credentials.
    throw new Error('Pi run failed');
  }
}
