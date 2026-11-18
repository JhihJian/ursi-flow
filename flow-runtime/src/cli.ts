#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentRunModel, HeadlessPi, JsonFileRunStore, createFlowCoordinator, loadFlow } from './index.ts';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    variables: { type: 'string', default: '{}' }, cwd: { type: 'string', default: process.cwd() },
    history: { type: 'string' }, model: { type: 'string' },
  } });
  const [cmd, path] = positionals;
  if (positionals.length !== 2 || !['check','run'].includes(cmd)) throw new Error('用法：ursi-flow check|run <包目录或 FLOW.md> [--variables JSON] [--cwd 目录] [--model ID] [--history 文件]');
  const pkg = await loadFlow(path);
  if (cmd === 'check') { console.log(JSON.stringify({ id: pkg.flow.id, nodes: pkg.flow.nodes.size, children: [...pkg.references.keys()] })); return; }
  const harness = new HeadlessPi({ model: values.model });
  const cwd = resolve(values.cwd);
  const runtime = createFlowCoordinator({ ...pkg, agentModel: new AgentRunModel(harness, harness.extensions),
    store: new JsonFileRunStore(resolve(values.history ?? resolve(cwd, '.ursi-flow', 'history.json'))) });
  const record = await runtime.run({ variables: JSON.parse(values.variables) }, { cwd, flowPath: pkg.path });
  console.log(JSON.stringify(record));
  if (record.status !== 'completed') process.exitCode = 1;
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
