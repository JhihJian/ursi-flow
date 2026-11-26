export interface ExecutorRef {
    id: string;
    revision: number;
}
export declare function parseExecutorRef(value: unknown): ExecutorRef;
export declare function platformConfig(env?: NodeJS.ProcessEnv): {
    origin: string;
    token: string;
};
export type PlatformConfig = ReturnType<typeof platformConfig>;
export declare class PlatformClient {
    private readonly config;
    constructor(config: PlatformConfig);
    private request;
    checkNodeExecutor(ref: ExecutorRef): Promise<void>;
    /** 按执行器 id 解析当前最新发布修订并校验能力；名称不存在或修订缺 flowOutcome 能力时抛错。 */
    resolveExecutor(id: string): Promise<{
        id: string;
        revision: number;
    }>;
    private path;
    start(id: string, body: unknown): Promise<void>;
    inspect(id: string): Promise<{
        status: string;
        artifactDirectoryId: unknown;
    }>;
    cancel(id: string): Promise<boolean>;
    outcome(directory: unknown): Promise<unknown>;
}
//# sourceMappingURL=platform.d.ts.map