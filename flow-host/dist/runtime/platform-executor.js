import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProcessCommandExecutor } from "../executor-adapters/local-pi/process-command.js";
import { ExecutorUnconfirmed } from "ursi-flow-runtime";
import { isRecord } from "ursi-flow-core/runtime";
import { PlatformClient } from "../executor-adapters/platform.js";
import { renderAgentPrompt } from "./prompt.js";
import { allowedVariablesOf, parseRuntimeOutcome } from "./tools/bridge.js";
/** 平台无法确认尝试状态：引擎据此把 Run 标为待核实，`resume` 只查询原尝试。 */
export class AttemptUnconfirmed extends ExecutorUnconfirmed {
}
/**
 * 平台执行器：把独立的 Agent 节点交给执行器平台，命令节点不支持。
 * 每次节点访问的 attemptId 按 stepId 记在宿主侧，重试与恢复只查询原尝试。
 */
export class PlatformExecutor {
    client;
    ref;
    file;
    commands = new ProcessCommandExecutor();
    packageRoot;
    constructor(config, ref, dir, options = {}) {
        this.client = new PlatformClient(config);
        this.ref = ref;
        this.file = join(dir, "attempts.json");
        this.packageRoot = options.packageRoot;
    }
    async prompt(agentName, instruct) {
        const attempts = await this.attempts();
        let attemptId = attempts[instruct.stepId];
        if (!attemptId) {
            attemptId = randomUUID();
            attempts[instruct.stepId] = attemptId;
            await this.saveAttempts(attempts);
            const allowed = allowedVariablesOf(instruct.outcomes);
            await this.client.start(attemptId, {
                executorRef: this.ref,
                workInstruction: {
                    text: renderAgentPrompt(instruct),
                    encoding: "utf-8",
                },
                runConfig: {
                    nodeContract: {
                        outcomes: instruct.outcomes.map((option) => option.name),
                        variables: [...new Set([...allowed.values()].flat())],
                    },
                },
            });
        }
        for (;;) {
            let state;
            try {
                state = await this.client.inspect(attemptId);
            }
            catch (error) {
                throw new AttemptUnconfirmed(error instanceof Error ? error.message : String(error));
            }
            if (state.status === "succeeded") {
                const artifact = await this.client.outcome(state.artifactDirectoryId);
                const outcome = parseRuntimeOutcome({ toolName: "submit_flow_outcome", arguments: artifact }, instruct.outcomes, allowedVariablesOf(instruct.outcomes));
                return {
                    outcome: outcome.result,
                    ...(outcome.variables === undefined
                        ? {}
                        : { variables: outcome.variables }),
                };
            }
            if (state.status === "unverified")
                throw new AttemptUnconfirmed(`执行器尝试 ${attemptId} 状态待核实，请稍后恢复运行`);
            if (state.status === "failed" || state.status === "cancelled")
                throw new Error(`执行器尝试 ${attemptId}: ${state.status}`);
            await delay(1000);
        }
    }
    /** 命令节点不属于平台执行器契约，仍在 daemon 侧以当前用户权限运行。 */
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
    packagePath(arg) {
        if (!/^scripts\/[^\0]+$/.test(arg) || arg.includes(".."))
            return arg;
        return join(this.packageRoot, arg);
    }
    /** 停止时取消所有未完成尝试。 */
    async cancel() {
        const attempts = await this.attempts();
        const confirmed = await Promise.all(Object.values(attempts).map((attemptId) => this.client.cancel(attemptId).catch(() => false)));
        return confirmed.every(Boolean);
    }
    async attempts() {
        try {
            const parsed = JSON.parse(await readFile(this.file, "utf8"));
            return isRecord(parsed)
                ? Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === "string"))
                : {};
        }
        catch (error) {
            if (error.code === "ENOENT")
                return {};
            throw error;
        }
    }
    async saveAttempts(attempts) {
        const temporary = `${this.file}.${process.pid}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify(attempts), { mode: 0o600 });
            await rename(temporary, this.file);
        }
        finally {
            await rm(temporary, { force: true }).catch(() => undefined);
        }
    }
}
//# sourceMappingURL=platform-executor.js.map