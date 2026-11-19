#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentRunModel, JsonFileRunStore, PiSdkHarness, createFlowCoordinator, loadFlow } from './index.ts';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    variables: { type: 'string', default: '{}' }, cwd: { type: 'string', default: process.cwd() },
    history: { type: 'string' },
    'base-url': { type: 'string' }, 'api-key': { type: 'string' }, model: { type: 'string' },
    api: { type: 'string' }, 'context-window': { type: 'string' }, 'max-tokens': { type: 'string' },
  } });
  const [cmd, path] = positionals;
  if (positionals.length !== 2 || !['check','run'].includes(cmd)) throw new Error('用法：ursi-flow check|run <包目录或 FLOW.md> [--variables JSON] [--cwd 目录] [--base-url URL --api-key KEY --model ID] [--api 协议] [--history 文件]');
  const pkg = await loadFlow(path);
  if (cmd === 'check') { console.log(JSON.stringify({ id: pkg.flow.id, nodes: pkg.flow.nodes.size, children: [...pkg.references.keys()] })); return; }
  const baseUrl = values['base-url'] ?? process.env.URSI_FLOW_BASE_URL;
  const apiKey = values['api-key'] ?? process.env.URSI_FLOW_API_KEY;
  if (!baseUrl || !apiKey || !values.model)
    throw new Error('Agent 节点需要模型接入信息：--base-url、--api-key 与 --model（也可用环境变量 URSI_FLOW_BASE_URL、URSI_FLOW_API_KEY）');
  const harness = new PiSdkHarness({
    baseUrl, apiKey, model: values.model,
    ...(values.api ? { api: values.api as never } : {}),
    ...(values['context-window'] ? { contextWindow: Number(values['context-window']) } : {}),
    ...(values['max-tokens'] ? { maxTokens: Number(values['max-tokens']) } : {}),
  });
  const cwd = resolve(values.cwd);
  const runtime = createFlowCoordinator({ ...pkg, agentModel: new AgentRunModel(harness, harness.extensions),
    store: new JsonFileRunStore(resolve(values.history ?? resolve(cwd, '.ursi-flow', 'history.json'))) });
  const record = await runtime.run({ variables: JSON.parse(values.variables) }, { cwd, flowPath: pkg.path });
  console.log(JSON.stringify(record));
  if (record.status !== 'completed') process.exitCode = 1;
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
