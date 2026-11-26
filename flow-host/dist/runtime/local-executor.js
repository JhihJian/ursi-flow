import { ProcessCommandExecutor } from "../executor-adapters/local-pi/process-command.js";
import { join } from "node:path";
import { renderAgentPrompt } from "./prompt.js";
import { allowedVariablesOf, RuntimeOutcomeBridge } from "./tools/bridge.js";
/** 本地执行器：Pi SDK 会话执行 Agent，子进程执行命令。 */
export class LocalExecutor {
    harness;
    commands = new ProcessCommandExecutor();
    /** Flow 包根目录：命令参数里的 scripts/ 相对它定位。 */
    packageRoot;
    constructor(harness, options = {}) {
        this.harness = harness;
        this.packageRoot = options.packageRoot;
    }
    async prompt(agentName, instruct) {
        const bridge = new RuntimeOutcomeBridge(instruct.stepId, instruct.outcomes, allowedVariablesOf(instruct.outcomes));
        if (process.env.URSI_FLOWD_DEBUG === "1")
            console.error("prompt begin", instruct.stepId, JSON.stringify(instruct.outcomes));
        const agent = await this.harness.open({
            runId: instruct.runId,
            ...(instruct.cwd === undefined ? {} : { cwd: instruct.cwd }),
            runtimeTools: bridge,
        });
        try {
            if (process.env.URSI_FLOWD_DEBUG === "1")
                console.error("harness run", agent.id);
            const turn = await this.harness.run(agent, {
                executionId: instruct.stepId,
                prompt: renderAgentPrompt(instruct),
            });
            if (process.env.URSI_FLOWD_DEBUG === "1")
                console.error("harness done", turn.status, Boolean(bridge.outcome), turn.error?.summary);
            const outcome = bridge.outcome;
            if (turn.status !== "completed" || !outcome)
                throw new Error(turn.error?.summary ??
                    `Agent 节点“${agentName}”没有提交合法结果`);
            return {
                outcome: outcome.result,
                ...(outcome.variables === undefined
                    ? {}
                    : { variables: outcome.variables }),
            };
        }
        finally {
            bridge.close();
            await this.harness.close(agent);
        }
    }
    async command(invocation) {
        const result = await this.commands.execute({
            ...invocation.request,
            ...(this.packageRoot && invocation.request.args
                ? { args: invocation.request.args.map((arg) => this.packagePath(arg)) }
                : {}),
            ...(invocation.request.cwd === undefined && invocation.cwd !== undefined
                ? { cwd: invocation.cwd }
                : {}),
        });
        return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
        };
    }
    /** 只把独立的 scripts/... 参数定位到包内文件，其他参数原样传递。 */
    packagePath(arg) {
        if (!/^scripts\/[^\0]+$/.test(arg) || arg.includes(".."))
            return arg;
        return join(this.packageRoot, arg);
    }
}
//# sourceMappingURL=local-executor.js.map