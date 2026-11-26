import { type ExecutorResult, type ExecutorStartRequest } from "ursi-executor-sdk";
export { ExecutorError, LEGACY_VERSION as MCP_PROTOCOL_VERSION, parseAttemptRequest, parseStartRequest } from "ursi-executor-sdk";
export type { ExecutorErrorCode, ExecutorResult, ExecutorStartRequest, ExecutorStatus } from "ursi-executor-sdk";
export declare const EXECUTOR_SERVER_NAME = "ursi-flow-executor";
export declare const EXECUTOR_SERVER_VERSION = "0.1.0";
export interface RuntimeJob {
    executorRef?: unknown;
    id: string;
    flow: string;
    revision: string;
    cwd: string;
    variables: Record<string, unknown>;
    status: string;
}
export interface RuntimeClient {
    startPinned(id: string, flow: string, cwd: string, variables: Record<string, unknown>, revision: string): Promise<RuntimeJob>;
    get(id: string): Promise<RuntimeJob>;
    stop(id: string): Promise<RuntimeJob>;
}
export declare class UnixRuntimeClient implements RuntimeClient {
    private readonly socketPath;
    constructor(socketPath: string);
    startPinned(id: string, flow: string, cwd: string, variables: Record<string, unknown>, revision: string): Promise<RuntimeJob>;
    get(id: string): Promise<RuntimeJob>;
    stop(id: string): Promise<RuntimeJob>;
}
export declare class ExecutorAdapter {
    private readonly config;
    private readonly runtime;
    constructor(env?: NodeJS.ProcessEnv, runtime?: RuntimeClient);
    start(request: ExecutorStartRequest): Promise<ExecutorResult>;
    inspect(request: {
        attemptId: string;
    }): Promise<ExecutorResult>;
    cancel(request: {
        attemptId: string;
    }): Promise<ExecutorResult>;
    private matches;
}
//# sourceMappingURL=executor.d.ts.map