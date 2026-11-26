import type { CommandOutput, CommandInvocation, ExecutorReply, FlowExecutor, Instruct } from "ursi-flow-runtime";
import type { AgentHarness } from "./harness.ts";
/** 本地执行器：Pi SDK 会话执行 Agent，子进程执行命令。 */
export declare class LocalExecutor implements FlowExecutor {
    private readonly harness;
    private readonly commands;
    /** Flow 包根目录：命令参数里的 scripts/ 相对它定位。 */
    private readonly packageRoot?;
    constructor(harness: AgentHarness, options?: {
        packageRoot?: string;
    });
    prompt(agentName: string, instruct: Instruct): Promise<ExecutorReply>;
    command(invocation: CommandInvocation): Promise<CommandOutput>;
    /** 只把独立的 scripts/... 参数定位到包内文件，其他参数原样传递。 */
    private packagePath;
}
//# sourceMappingURL=local-executor.d.ts.map