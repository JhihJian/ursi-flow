import type { AgentHandle, AgentHarness, AgentOpenRequest } from "../../runtime/harness.ts";
/** Pi 支持的请求协议；默认用 OpenAI 兼容的 chat completions。 */
export declare const PROVIDER_APIS: readonly ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
export type ProviderApi = (typeof PROVIDER_APIS)[number];
export declare const THINKING_LEVELS: readonly ["off", "low", "medium", "high"];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/** 用户必须提供的模型接入配置。没有默认值，避免落到宿主机的 Pi 配置。 */
export interface PiProviderConfig {
    /** 模型服务地址，例如 https://api.deepseek.com 。 */
    baseUrl: string;
    /** 服务密钥。 */
    apiKey: string;
    /** 模型标识，例如 deepseek-chat 。 */
    model: string;
    /** 请求协议，默认 openai-completions 。 */
    api?: ProviderApi;
    /** 上下文窗口，缺省按 128k 处理。 */
    contextWindow?: number;
    /** 单次回复上限，缺省按 8192 处理。 */
    maxTokens?: number;
    /** 是否为推理模型，决定是否启用思考预算。 */
    reasoning?: boolean;
    /** 思考强度，缺省 low 。 */
    thinkingLevel?: ThinkingLevel;
}
export declare function validateProviderConfig(value: unknown): asserts value is PiProviderConfig;
export interface PiSdkHarnessOptions {
    /** 每个 Agent 节点执行的会话轨迹目录；缺省不落盘。 */
    trajectoryDir?: string;
}
export declare class PiSdkHarness implements AgentHarness {
    private readonly sessions;
    private readonly modelRuntime;
    private readonly config;
    private readonly trajectoryDir?;
    constructor(config: PiProviderConfig, options?: PiSdkHarnessOptions);
    private state;
    open(request: AgentOpenRequest): Promise<{
        id: `${string}-${string}-${string}-${string}-${string}`;
        platformReference: `${string}-${string}-${string}-${string}-${string}`;
        sessionReference: `${string}-${string}-${string}-${string}-${string}`;
    }>;
    /** 结果工具：把参数交给本次节点执行的桥，并要求 Pi 结束本轮。 */
    private outcomeTool;
    run(agent: AgentHandle, request: {
        executionId: string;
        prompt: string;
    }): Promise<{
        status: "failed";
        error: {
            category: string;
            summary: string;
        };
        session?: undefined;
    } | {
        status: "completed";
        session: {
            id: string;
            sessionReference: string;
        };
        error?: undefined;
    }>;
    close(agent: AgentHandle): Promise<void>;
}
//# sourceMappingURL=sdk.d.ts.map