import { ExecutorUnconfirmed } from "ursi-flow-runtime";
import type { CommandOutput, CommandInvocation, ExecutorReply, FlowExecutor, Instruct } from "ursi-flow-runtime";
import { type ExecutorRef, type PlatformConfig } from "../executor-adapters/platform.ts";
/** 平台无法确认尝试状态：引擎据此把 Run 标为待核实，`resume` 只查询原尝试。 */
export declare class AttemptUnconfirmed extends ExecutorUnconfirmed {
}
/**
 * 平台执行器：把独立的 Agent 节点交给执行器平台，命令节点不支持。
 * 每次节点访问的 attemptId 按 stepId 记在宿主侧，重试与恢复只查询原尝试。
 */
export declare class PlatformExecutor implements FlowExecutor {
    private readonly client;
    private readonly ref;
    private readonly file;
    private readonly commands;
    private readonly packageRoot?;
    constructor(config: PlatformConfig, ref: ExecutorRef, dir: string, options?: {
        packageRoot?: string;
    });
    prompt(agentName: string, instruct: Instruct): Promise<ExecutorReply>;
    /** 命令节点不属于平台执行器契约，仍在 daemon 侧以当前用户权限运行。 */
    command(invocation: CommandInvocation): Promise<CommandOutput>;
    private packagePath;
    /** 停止时取消所有未完成尝试。 */
    cancel(): Promise<boolean>;
    attempts(): Promise<Record<string, string>>;
    private saveAttempts;
}
//# sourceMappingURL=platform-executor.d.ts.map