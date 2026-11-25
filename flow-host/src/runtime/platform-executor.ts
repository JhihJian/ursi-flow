import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
	CommandOutput,
	CommandInvocation,
	ExecutorReply,
	FlowExecutor,
	Instruct,
} from "ursi-flow-runtime";
import { isRecord } from "ursi-flow-core/runtime";
import { PlatformClient, type ExecutorRef, type PlatformConfig } from "../executor-adapters/platform.ts";
import { renderAgentPrompt } from "./prompt.ts";
import { allowedVariablesOf, parseRuntimeOutcome } from "./tools/bridge.ts";

/** 平台无法确认尝试状态：宿主据此把 Run 标为待核实，`resume` 只查询原尝试。 */
export class AttemptUnconfirmed extends Error {}

/**
 * 平台执行器：把独立的 Agent 节点交给执行器平台，命令节点不支持。
 * 每次节点访问的 attemptId 按 stepId 记在宿主侧，重试与恢复只查询原尝试。
 */
export class PlatformExecutor implements FlowExecutor {
	private readonly client: PlatformClient;
	private readonly ref: ExecutorRef;
	private readonly file: string;

	constructor(config: PlatformConfig, ref: ExecutorRef, dir: string) {
		this.client = new PlatformClient(config);
		this.ref = ref;
		this.file = join(dir, "attempts.json");
	}

	async prompt(agentName: string, instruct: Instruct): Promise<ExecutorReply> {
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
			const state = await this.client.inspect(attemptId);
			if (state.status === "succeeded") {
				const artifact = await this.client.outcome(state.artifactDirectoryId);
				const outcome = parseRuntimeOutcome(
					{ toolName: "submit_flow_outcome", arguments: artifact },
					instruct.outcomes,
					allowedVariablesOf(instruct.outcomes),
				);
				return {
					outcome: outcome.result,
					...(outcome.variables === undefined
						? {}
						: { variables: outcome.variables }),
				};
			}
			if (state.status === "unverified")
				throw new AttemptUnconfirmed(
					`执行器尝试 ${attemptId} 状态待核实，请稍后恢复运行`,
				);
			if (state.status === "failed" || state.status === "cancelled")
				throw new Error(`执行器尝试 ${attemptId}: ${state.status}`);
			await delay(1000);
		}
	}

	async command(_invocation: CommandInvocation): Promise<CommandOutput> {
		throw new Error("平台执行器只负责独立的 Agent 节点，不支持命令节点");
	}

	/** 停止时取消所有未完成尝试。 */
	async cancel(): Promise<boolean> {
		const attempts = await this.attempts();
		const confirmed = await Promise.all(
			Object.values(attempts).map((attemptId) =>
				this.client.cancel(attemptId).catch(() => false),
			),
		);
		return confirmed.every(Boolean);
	}

	async attempts(): Promise<Record<string, string>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
			return isRecord(parsed)
				? Object.fromEntries(
						Object.entries(parsed).filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === "string",
						),
					)
				: {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	private async saveAttempts(attempts: Record<string, string>): Promise<void> {
		const temporary = `${this.file}.${process.pid}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(attempts), { mode: 0o600 });
			await rename(temporary, this.file);
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}
}
