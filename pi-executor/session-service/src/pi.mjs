import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export { SessionManager };

export async function createPi({ root, cwd, modelId, baseUrl, apiKey, reference }) {
  const provider = 'ursi-session';
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    credentials: {
      async read(id) { return id === provider ? { type: 'api_key', key: apiKey } : undefined; },
      async list() { return [{ providerId: provider, type: 'api_key' }]; },
      async modify() { throw new Error('Read-only credentials'); },
      async delete() { throw new Error('Read-only credentials'); },
    },
  });
  modelRuntime.registerProvider(provider, {
    name: 'Pi session model', baseUrl, api: 'openai-completions',
    models: [{ id: modelId, name: modelId, api: 'openai-completions', reasoning: false, input: ['text'],
      contextWindow: 128_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error('Pi model configuration is invalid');
  const tools = reference === undefined ? [] : [{
    name: 'read_reference', label: 'Read reference', description: 'Read the reference material provided by the operator.',
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: reference }], details: {} }; },
  }];
  const systemPrompt = 'You are a helpful assistant.';
  const publicModel = ({ id, name, provider, contextWindow, maxTokens }) => ({ id, name, provider, contextWindow, maxTokens });
  const publicPrompt = text => text.replaceAll(apiKey, '[redacted]').replaceAll(cwd, '[workspace]').replaceAll(root, '[state]');
  const runtimeInfo = {
    scope: 'service', systemPrompt,
    model: publicModel(model),
    tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters, active: true })),
    skills: [], mcp: [],
  };
  function effectiveRuntime(session) {
    const active = new Set(session.getActiveToolNames());
    return {
      ...runtimeInfo, scope: 'session', systemPrompt: publicPrompt(session.systemPrompt),
      model: publicModel(session.model ?? model),
      tools: runtimeInfo.tools.filter(tool => active.has(tool.name)),
    };
  }
  async function openPi(sessionManager) {
    const runtime = createExtensionRuntime();
    const { session } = await createAgentSession({
      cwd, agentDir: root, modelRuntime, model, thinkingLevel: 'off',
      sessionManager, noTools: 'builtin', tools: tools.map(tool => tool.name), customTools: tools,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off',
      }),
      resourceLoader: {
        getExtensions: () => ({ runtime, extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => systemPrompt,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
        extendResources() {}, async reload() {},
      },
    });
    return session;
  }
  return { openPi, runtimeInfo, effectiveRuntime };
}
