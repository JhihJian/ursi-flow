import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PiProviderConfig } from '../executor-adapters/local-pi/sdk.ts';
import { parseConfig } from './files.ts';
import { loadPolicy, type Policy, type ToolRef } from './policy.ts';
import { resources } from './resources.ts';
import { RuntimeOutcomeBridge } from "ursi-flow-core/engine";
import type { NodeContract } from './node-contract.ts';
import { openWorkspace, publishAnswer, publishArtifact } from './session-files.ts';
import { sessionTools } from './tools.ts';

export interface SkillFile { path: string; contentBase64: string; sha256: string }
export interface PiConfig {
  systemPrompt: string;
  modelProfile: string;
  skills: { id: string; revision: number; content: string; files?: SkillFile[] }[];
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

export type PiStop = 'end_turn' | 'error' | 'cancelled' | 'max_tokens' | 'max_turn_requests';

export async function preparePi(options: {
  config: PiConfig; workspace: string; policyPath: string; policy?: Policy; signal: AbortSignal;
  nodeContract?: NodeContract; preflight?: boolean; manager?: SessionManager;
}) {
  const { workspace, policyPath, signal, nodeContract, preflight } = options;
  const config = parseConfig(options.config);
  signal.throwIfAborted();
  if (policyPath === workspace || policyPath.startsWith(workspace + '/')) throw new Error('Invalid Pi policy location');
  const policy = options.policy ?? await loadPolicy(policyPath);
  const provider = policy.models.find(m => m.id === config.modelProfile)?.provider;
  if (!provider) throw new Error('Unknown model profile');
  const secrets = [provider.apiKey, ...policy.tools.flatMap(t => t.token ? [t.token] : [])];
  const manager = options.manager ?? SessionManager.inMemory(workspace);
  const root = preflight ? undefined : await openWorkspace(workspace);
  const flow = nodeContract && new RuntimeOutcomeBridge(workspace,
    nodeContract.outcomes.map(name => ({ name, description: '' })),
    new Map(nodeContract.outcomes.map(name => [name, nodeContract.variables])));
  let active: AbortSignal | undefined;
  try {
    const tools = root ? sessionTools(root, policyPath, policy, config, () => active ?? signal, flow) : [];
    const { session } = await createAgentSession({
      cwd: workspace, agentDir: workspace, ...await createModel(provider, signal), thinkingLevel: provider.thinkingLevel ?? 'off',
      tools: tools.map(t => t.name), noTools: 'builtin', customTools: tools,
      sessionManager: manager, settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off',
      }), resourceLoader: resources(config),
    });
    if (signal.aborted) { session.dispose(); signal.throwIfAborted(); }
    return {
      manager, secrets, toolNames: tools.map(t => t.name),
      async close() {
        session.dispose();
        flow?.close();
        await root?.close();
      },
      async run(instruction: string, signal: AbortSignal, observe?: (event: AgentSessionEvent) => void, committed?: () => void): Promise<PiStop> {
        if (active || !instruction.trim() || Buffer.byteLength(instruction) > 256 * 1024) return 'error';
        active = signal;
        let toolFailed = false, turns = 0, timedOut = false;
        const abort = () => { void session.abort().catch(() => {}); };
        // Pi 1.5.2's loop emits agent_start before appending the user message. Abort alone
        // does not prevent insertion during SDK preflight. Throw at that last pre-insertion
        // boundary so the core settles without appending the user message or invoking a model.
        const unguard = session.agent.subscribe(event => { if (event.type === 'agent_start') signal.throwIfAborted(); });
        const unsubscribe = session.subscribe(event => {
          if (event.type === 'tool_execution_end' && event.isError) { toolFailed = true; abort(); }
          if (event.type === 'turn_start' && ++turns > 32) abort();
          observe?.(event);
        });
        const timer = setTimeout(() => { timedOut = true; abort(); }, 30 * 60_000);
        timer.unref();
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          await session.prompt(instruction, { expandPromptTemplates: false });
          signal.throwIfAborted();
          const last = session.messages.at(-1);
          if (timedOut || toolFailed) return 'error';
          if (turns > 32) return 'max_turn_requests';
          if (last?.role === 'assistant' && last.stopReason === 'length') return 'max_tokens';
          if (last?.role !== 'assistant' || last.stopReason !== 'stop' || last.content.some(c => c.type === 'toolCall')) return 'error';
          const checkSecrets = (text: string) => {
            if (secrets.some(secret => text.includes(secret))) throw new Error('Invalid result');
          };
          const answer = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          checkSecrets(answer);
          if (root && flow) {
            const accepted = flow.outcome;
            if (!accepted) return 'error';
            const json = JSON.stringify({ outcome: accepted.result, variables: accepted.variables ?? {} }, (key, value) => {
              checkSecrets(key);
              if (typeof value === 'string') checkSecrets(value);
              return value;
            });
            await publishArtifact(root, 'flow-outcome.json', json, signal, committed);
          } else if (root) await publishAnswer(root, answer, signal, committed);
          return 'end_turn';
        } catch {
          return signal.aborted ? 'cancelled' : 'error';
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          unguard();
          unsubscribe();
          active = undefined;
        }
      },
    };
  } catch (error) {
    flow?.close();
    await root?.close();
    throw error;
  }
}

export async function runPi(config: PiConfig, workspace: string, instruction: string, signal: AbortSignal, nodeContract?: NodeContract): Promise<void> {
  let stop: PiStop;
  try {
    const policyPath = process.env.URSI_PI_POLICY;
    if (!policyPath || !instruction.trim() || Buffer.byteLength(instruction) > 256 * 1024) throw new Error('Invalid Pi configuration');
    const pi = await preparePi({ config, workspace, policyPath, signal, nodeContract });
    try { stop = await pi.run(instruction, signal); }
    finally { await pi.close(); }
  } catch { stop = signal.aborted ? 'cancelled' : 'error'; }
  if (stop === 'cancelled') throw new DOMException('Pi run cancelled', 'AbortError');
  if (stop !== 'end_turn') throw new Error('Pi run failed');
}
