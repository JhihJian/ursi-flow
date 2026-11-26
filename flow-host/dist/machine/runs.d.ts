import { Catalog } from "./catalog.ts";
import { type ExecutorRef } from "../executor-adapters/platform.ts";
import type { PiProviderConfig } from "../executor-adapters/local-pi/sdk.ts";
export interface Config {
    executor: "local-pi";
    provider: PiProviderConfig;
    maxConcurrent: number;
    /** 工作区根目录；启动运行没有指定工作目录时，在其下按 Run ID 新建目录。 */
    workspace: string;
}
/** 记录与接口里的配置：密钥只保留“是否已配置”，不写入 job.json，也不回传给页面。 */
export interface PublicConfig {
    executor: "local-pi";
    provider: Omit<PiProviderConfig, "apiKey"> & {
        apiKeySet: boolean;
    };
    maxConcurrent: number;
    workspace: string;
}
export declare function publicConfig(config: Config): PublicConfig;
interface Job {
    executorRef?: ExecutorRef;
    platformOrigin?: string;
    stopRequested?: boolean;
    id: string;
    flow: string;
    revision: string;
    cwd: string;
    variables: Record<string, unknown>;
}
export type JobView = Job & {
    status: string;
    error?: string;
};
export declare class Runs {
    readonly active: Map<string, {
        pid: number;
        done: Promise<void>;
        stop: boolean;
    }>;
    readonly catalog: Catalog;
    private readonly store;
    constructor(catalog: Catalog);
    dir(key: string): string;
    /** 运行状态由日志快照推导；job.json 只保存受理意图。 */
    private view;
    list(): Promise<(Job & {
        status: string;
        error?: string;
    })[]>;
    private readJob;
    private find;
    get(key: string): Promise<JobView>;
    history(key: string): Promise<{
        job: JobView;
        runs: import("./history.ts").RunFact[];
        nodeRuns: import("./history.ts").NodeFact[];
        routeDecisions: Record<string, unknown>[];
        parallelRounds: Record<string, unknown>[];
        recoveries: Record<string, unknown>[];
    }>;
    /** 一次 Agent 节点执行的 Pi 会话轨迹切片；命令节点没有轨迹文件。 */
    trajectory(key: string, node: string): Promise<{
        node: string;
        size: number;
        jsonl: string;
        omitted: boolean;
    } | {
        node: string;
        size: number;
        jsonl: string;
        omitted?: undefined;
    }>;
    start(key: string, flow: string, cwd: string | undefined, variables: Record<string, unknown>, readConfig: () => Promise<Config>, expectedRevision?: string, executorRef?: ExecutorRef): Promise<JobView>;
    private launch;
    private boundPlatform;
    resume(key: string, readConfig: () => Promise<Config>): Promise<JobView>;
    /** 人工应答：校验等待状态与节点匹配后，以应答模式重启 worker。 */
    respond(key: string, nodeRunId: string, result: string, readConfig: () => Promise<Config>): Promise<JobView>;
    stop(key: string): Promise<JobView>;
    /** 用引擎写一条停止事实：之后的状态与应答都以它为准。 */
    private markStopped;
    shutdown(key: string): Promise<JobView | undefined>;
}
export {};
//# sourceMappingURL=runs.d.ts.map