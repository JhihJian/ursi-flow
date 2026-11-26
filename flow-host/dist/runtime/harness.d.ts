import type { FlowVariables } from "ursi-flow-core";
export interface RuntimeToolDefinition {
    name: string;
    description: string;
    /** JSON Schema 对象；宿主注册工具时必须保留其约束。 */
    inputSchema: Record<string, unknown>;
}
export interface RuntimeToolCall {
    callId?: string;
    toolName: string;
    /** 不可信的宿主输入：接受前必须校验。 */
    arguments: unknown;
}
export interface RuntimeToolResult {
    content?: string;
    stopExecution?: boolean;
}
export interface RuntimeToolBridge {
    readonly definitions: readonly RuntimeToolDefinition[];
    invoke(call: RuntimeToolCall): Promise<RuntimeToolResult>;
}
export interface AgentHandle {
    id: string;
    sessionReference?: string;
}
export interface AgentOpenRequest {
    runId: string;
    cwd?: string;
    runtimeTools: RuntimeToolBridge;
}
export interface AgentTurnState {
    status: "completed" | "failed" | "interrupted";
    error?: {
        summary: string;
    };
}
/** 宿主侧的 Agent 会话端口；引擎不依赖它，只有本地执行器使用。 */
export interface AgentHarness {
    open(request: AgentOpenRequest): Promise<AgentHandle>;
    run(agent: AgentHandle, request: {
        executionId: string;
        prompt: string;
    }): Promise<AgentTurnState>;
    close(agent: AgentHandle): Promise<void>;
}
/** 一次节点访问的结果。outcome 是节点声明的结果名。 */
export interface NodeOutcome {
    result: string;
    variables?: FlowVariables;
}
//# sourceMappingURL=harness.d.ts.map