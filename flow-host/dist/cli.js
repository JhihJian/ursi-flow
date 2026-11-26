#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { FileLogStore, FlowEngine } from 'ursi-flow-runtime';
import { LocalExecutor } from "./runtime/local-executor.js";
import { PiSdkHarness } from "./executor-adapters/local-pi/sdk.js";
import { parseFlow } from 'ursi-flow-core/runtime';
async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
            variables: { type: 'string', default: '{}' }, cwd: { type: 'string', default: process.cwd() },
            store: { type: 'string' }, run: { type: 'string' },
            'base-url': { type: 'string' }, 'api-key': { type: 'string' }, model: { type: 'string' },
            trajectories: { type: 'string' },
            api: { type: 'string' }, 'context-window': { type: 'string' }, 'max-tokens': { type: 'string' },
        } });
    const [cmd, path] = positionals;
    if (positionals.length !== 2 || !['check', 'run'].includes(cmd))
        throw new Error('用法：ursi-flow-local check|run <包目录或 FLOW.md> [--variables JSON] [--cwd 目录] [--store 目录] [--base-url URL --api-key KEY --model ID] [--api 协议] [--trajectories 目录]');
    const flowPath = resolve(path.endsWith('FLOW.md') ? path : resolve(path, 'FLOW.md'));
    const text = await readFile(flowPath, 'utf8');
    const flowId = resolve(flowPath, '..').split(/[\\/]/).filter(Boolean).at(-1) ?? 'inline';
    const parsed = parseFlow(text, flowId);
    if (cmd === 'check') {
        console.log(JSON.stringify({ id: parsed.id, nodes: parsed.nodes.size, parallels: parsed.parallels.size }));
        return;
    }
    const baseUrl = values['base-url'] ?? process.env.URSI_FLOW_BASE_URL;
    const apiKey = values['api-key'] ?? process.env.URSI_FLOW_API_KEY;
    if (!baseUrl || !apiKey || !values.model)
        throw new Error('Agent 节点需要模型接入信息：--base-url、--api-key 与 --model（也可用环境变量 URSI_FLOW_BASE_URL、URSI_FLOW_API_KEY）');
    const cwd = resolve(values.cwd);
    const harness = new PiSdkHarness({
        baseUrl, apiKey, model: values.model,
        ...(values.api ? { api: values.api } : {}),
        ...(values['context-window'] ? { contextWindow: Number(values['context-window']) } : {}),
        ...(values['max-tokens'] ? { maxTokens: Number(values['max-tokens']) } : {}),
    }, { trajectoryDir: resolve(values.trajectories ?? resolve(cwd, '.ursi-flow', 'trajectories')) });
    const engine = new FlowEngine({
        executor: new LocalExecutor(harness, { packageRoot: resolve(flowPath, '..') }),
        store: new FileLogStore(resolve(values.store ?? resolve(cwd, '.ursi-flow'))),
    });
    const result = await engine.start({
        flow: { id: parsed.id, text, path: flowPath },
        variables: JSON.parse(values.variables),
        cwd,
        ...(values.run ? { runId: values.run } : {}),
    });
    console.log(JSON.stringify(result));
    if (result.status !== 'completed')
        process.exitCode = 1;
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
//# sourceMappingURL=cli.js.map