// Pi SDK 执行器：在 daemon 进程内创建会话，模型由用户配置的 provider 提供，
// 不依赖宿主机的 pi 可执行文件、Pi 扩展或 Pi 全局凭据。
import { createAgentSession, ModelRuntime, SettingsManager, SessionManager, } from "@earendil-works/pi-coding-agent";
import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { NodeTrajectoryRecorder } from "./trajectory.js";
import { isRecord } from "ursi-flow-core/runtime";
/** Pi 支持的请求协议；默认用 OpenAI 兼容的 chat completions。 */
export const PROVIDER_APIS = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
];
export const THINKING_LEVELS = ["off", "low", "medium", "high"];
/** 固定使用独立 provider id，避免和 Pi 内置 provider 重名。 */
const PROVIDER_ID = "flow-runtime";
/** Agent 节点可用的工作区工具：读写代码、执行命令、检索文件。 */
const WORKSPACE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const OUTCOME_TOOL = "submit_flow_outcome";
export function validateProviderConfig(value) {
    if (!isRecord(value))
        throw new Error("provider 必须是对象");
    for (const key of ["baseUrl", "apiKey", "model"]) {
        const field = value[key];
        if (typeof field !== "string" || !field.trim())
            throw new Error(`provider.${key} 必须是非空字符串`);
    }
    if (value.api !== undefined &&
        !PROVIDER_APIS.includes(value.api))
        throw new Error(`provider.api 只能是 ${PROVIDER_APIS.join("、")}`);
    if (value.thinkingLevel !== undefined &&
        !THINKING_LEVELS.includes(value.thinkingLevel))
        throw new Error(`provider.thinkingLevel 只能是 ${THINKING_LEVELS.join("、")}`);
    for (const key of ["contextWindow", "maxTokens"]) {
        const field = value[key];
        if (field !== undefined &&
            (typeof field !== "number" || !Number.isInteger(field) || field < 1))
            throw new Error(`provider.${key} 必须是正整数`);
    }
    if (value.reasoning !== undefined && typeof value.reasoning !== "boolean")
        throw new Error("provider.reasoning 必须是布尔值");
}
/** 只把用户配置的 provider 注册进运行时，不读取 Pi 的 models.json 与凭据。 */
async function createModel(config) {
    const runtime = await ModelRuntime.create({
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
    });
    const api = config.api ?? "openai-completions";
    runtime.registerProvider(PROVIDER_ID, {
        name: "Flow Runtime",
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        api,
        models: [
            {
                id: config.model,
                name: config.model,
                api,
                reasoning: config.reasoning ?? false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: config.contextWindow ?? 128000,
                maxTokens: config.maxTokens ?? 8192,
            },
        ],
    });
    const model = runtime.getModel(PROVIDER_ID, config.model);
    if (!model)
        throw new Error(`Provider 配置未生成模型: ${config.model}`);
    return { runtime, model };
}
/** 不发现扩展、Skill、Prompt 模板与项目上下文文件，提示词由 Flow 决定。 */
function isolatedLoader() {
    return {
        getExtensions: () => ({
            extensions: [],
            errors: [],
            runtime: createExtensionRuntime(),
        }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => "You are executing one node of a Flow. Do the work the prompt asks for, then report the result with submit_flow_outcome.",
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => { },
        reload: async () => { },
    };
}
export class PiSdkHarness {
    sessions = new Map();
    modelRuntime;
    config;
    trajectoryDir;
    constructor(config, options = {}) {
        validateProviderConfig(config);
        this.config = config;
        this.trajectoryDir = options.trajectoryDir;
        this.modelRuntime = createModel(config);
    }
    state(agent) {
        const state = this.sessions.get(agent.id);
        if (!state)
            throw new Error("Pi 会话未绑定");
        return state;
    }
    async open(request) {
        const id = randomUUID();
        const state = {
            session: undefined,
            bridge: request.runtimeTools,
            cwd: request.cwd,
            submitted: false,
            failure: undefined,
            invalid: 0,
        };
        const { runtime, model } = await this.modelRuntime;
        this.sessions.set(id, state);
        const { session } = await createAgentSession({
            cwd: request.cwd,
            model,
            modelRuntime: runtime,
            thinkingLevel: this.config.thinkingLevel ?? "low",
            // 允许清单里必须带上结果工具，否则节点无法提交结果。
            tools: [...WORKSPACE_TOOLS, OUTCOME_TOOL],
            customTools: [this.outcomeTool({ id })],
            sessionManager: SessionManager.inMemory(request.cwd),
            settingsManager: SettingsManager.inMemory({
                compaction: { enabled: false },
            }),
            resourceLoader: isolatedLoader(),
        });
        this.sessions.get(id).session = session;
        return { id, platformReference: id, sessionReference: id };
    }
    /** 结果工具：把参数交给本次节点执行的桥，并要求 Pi 结束本轮。 */
    outcomeTool(agent) {
        const harness = this;
        return {
            name: OUTCOME_TOOL,
            label: "提交节点结果",
            description: "Submit the current Flow node result exactly once after completing its work.",
            promptSnippet: "Submit the current Flow node result exactly once after completing its work.",
            parameters: Type.Unsafe({
                type: "object",
                properties: {
                    outcome: { type: "string", minLength: 1 },
                    variables: { type: "object" },
                },
                required: ["outcome"],
                additionalProperties: false,
            }),
            executionMode: "sequential",
            async execute(_id, params) {
                const state = harness.state(agent);
                if (state.submitted)
                    throw new Error("当前节点已提交结果");
                const definition = state.bridge.definitions.find((item) => item.name === OUTCOME_TOOL);
                const allowed = outcomeNames(definition?.inputSchema);
                const outcome = params.outcome;
                // 结果名或变量不合法都计入同一次拒绝，避免模型无限重试。
                const reject = (message) => {
                    state.failure = message;
                    state.invalid++;
                    if (state.invalid >= 3)
                        return {
                            content: [
                                { type: "text", text: `${message}。已停止本节点执行。` },
                            ],
                            details: { rejected: true },
                            terminate: true,
                        };
                    throw new Error(message);
                };
                if (allowed.length && !allowed.includes(String(outcome)))
                    return reject(`节点不允许结果: ${String(outcome)}。可选结果: ${allowed.join("、")}`);
                let result;
                try {
                    result = await state.bridge.invoke({
                        toolName: OUTCOME_TOOL,
                        arguments: params,
                    });
                }
                catch (error) {
                    return reject(error instanceof Error ? error.message : String(error));
                }
                state.submitted = true;
                return {
                    content: [{ type: "text", text: result.content }],
                    details: { submission: params },
                    terminate: true,
                };
            },
        };
    }
    async run(agent, request) {
        const state = this.state(agent);
        state.submitted = false;
        state.failure = undefined;
        state.invalid = 0;
        let recorder = this.trajectoryDir
            ? new NodeTrajectoryRecorder({
                dir: this.trajectoryDir,
                source: state.session.sessionManager,
                start: {
                    executionId: request.executionId,
                    ...(state.cwd ? { cwd: state.cwd } : {}),
                    model: this.config.model,
                },
            })
            : undefined;
        try {
            await recorder?.start();
        }
        catch (error) {
            // 建不了文件就放弃这份轨迹，避免写出没有会话头的半份 JSONL。
            console.error("无法建立节点会话轨迹", request.executionId, error);
            recorder = undefined;
        }
        try {
            await state.session.prompt(request.prompt);
        }
        catch (error) {
            return {
                status: "failed",
                error: {
                    category: "agent_execution",
                    summary: error instanceof Error ? error.message : String(error),
                },
            };
        }
        finally {
            await recorder?.stop();
        }
        if (!state.submitted)
            return {
                status: "failed",
                error: {
                    category: "agent_execution",
                    summary: state.failure ?? "Agent 结束前没有通过结果工具提交结果",
                },
            };
        return {
            status: "completed",
            session: { id: request.executionId, sessionReference: agent.id },
        };
    }
    async close(agent) {
        const state = this.sessions.get(agent.id);
        if (!state)
            return;
        this.sessions.delete(agent.id);
        state.session?.dispose();
    }
}
/** 结果工具的枚举值，用于在本地先给出可读的错误。 */
function outcomeNames(schema) {
    if (!isRecord(schema) || !isRecord(schema.properties))
        return [];
    const outcome = schema.properties.outcome;
    return isRecord(outcome) && Array.isArray(outcome.enum)
        ? outcome.enum.filter((item) => typeof item === "string")
        : [];
}
//# sourceMappingURL=sdk.js.map