import { randomUUID } from "node:crypto";
import { readCommandVariables, ready, submit } from "../../core/index.ts";
import type {
	CommandStep,
	CompletedStep,
	FlowContext,
	FlowVariables,
	ParallelStep,
} from "../../core/index.ts";
import { ExecutorUnconfirmed } from "../../executor/index.ts";
import type { ExecutorReply, FlowExecutor } from "../../executor/index.ts";
import type { Engine, EngineOptions, StartRequest } from "./contracts.ts";
import type { FlowFailure, PendingConfirm, RunResult } from "./outcome.ts";
import type {
	LogEventPayload,
	LogStore,
	RunHeader,
	RunSnapshot,
} from "../logs/index.ts";

export class EngineError extends Error {
	readonly code: "conflict" | "not_found" | "invalid";
	constructor(code: "conflict" | "not_found" | "invalid", message: string) {
		super(message);
		this.code = code;
	}
}

interface RunState {
	runId: string;
	context: FlowContext;
	seq: number;
	cwd?: string;
}

/**
 * Flow 文件到最终结果的推进器。每一步做三件事：把已渲染的提示词或命令交给执行器、
 * 校验回执后交给 Flow Core 选边、把过程写入日志。
 */
export class FlowEngine implements Engine {
	private readonly executor: FlowExecutor;
	private readonly store: LogStore;
	private readonly maxRejectedReplies: number;
	private readonly now: () => string;
	private readonly newId: () => string;

	constructor(options: EngineOptions) {
		this.executor = options.executor;
		this.store = options.store;
		this.maxRejectedReplies = options.maxRejectedReplies ?? 3;
		this.now = options.now ?? (() => new Date().toISOString());
		this.newId = options.newId ?? randomUUID;
	}

	async start(request: StartRequest): Promise<RunResult> {
		const runId = request.runId ?? this.newId();
		if (await this.exists(runId))
			throw new EngineError("conflict", `运行已存在: ${runId}`);
		let context: FlowContext;
		try {
			context = ready(request.flow.text, {
				flowId: request.flow.id,
				variables: request.variables ?? {},
			}).context;
		} catch (error) {
			throw new EngineError("invalid", messageOf(error));
		}
		await this.create(runId, {
			runId,
			flowId: context.flow.id,
			...(request.flow.path === undefined ? {} : { flowPath: request.flow.path }),
			...(request.cwd === undefined ? {} : { cwd: request.cwd }),
			flowText: request.flow.text,
			executor: this.executor.id,
			variables: context.variables,
			startedAt: this.now(),
		});
		const state: RunState = {
			runId,
			context,
			seq: 0,
			...(request.cwd === undefined ? {} : { cwd: request.cwd }),
		};
		await this.record(state, { type: "run.started", variables: context.variables });
		await this.saveSnapshot(state, "running");
		return this.advance(state);
	}

	/**
	 * 对等待人工确认的步骤提交一个结果名。非法提交抛 EngineError 且保持等待状态；
	 * 合法提交按该结果完成节点并继续路由，链式确认会再次返回 awaiting_input。
	 */
	async respond(runId: string, stepId: string, result: string): Promise<RunResult> {
		const stored = await this.require(runId);
		const { snapshot } = stored;
		if (snapshot.status !== "awaiting_input" || !snapshot.pending)
			throw new EngineError("invalid", "该运行不在等待人工确认");
		if (snapshot.pending.stepId !== stepId)
			throw new EngineError("invalid", "确认步骤与当前等待不匹配");
		if (!snapshot.pending.options.includes(result))
			throw new EngineError(
				"invalid",
				`无效的确认结果“${result}”，可选：${snapshot.pending.options.join("、")}`,
			);
		const nodeRef = snapshot.pending.nodeRef;
		const state: RunState = {
			runId,
			context: snapshot.context,
			seq: snapshot.seq,
			...(stored.header.cwd === undefined ? {} : { cwd: stored.header.cwd }),
		};
		// 先推进上下文：提交失败时保持等待状态，且不留下无法与快照对齐的事件。
		this.submitStep(state, { stepId, outcome: result });
		await this.record(state, { type: "confirm.answered", stepId, result });
		await this.record(state, {
			type: "route.selected",
			stepId,
			nodeRef,
			outcome: result,
			destination: destinationOf(snapshot.context, nodeRef, result),
			variables: state.context.variables,
		});
		await this.saveSnapshot(state, "running");
		return this.advance(state);
	}

	/**
	 * 从持久化快照继续。等待中的运行重新提问：换新的 stepId 重新渲染并再次挂起，
	 * 旧等待作废。
	 */
	async resume(runId: string): Promise<RunResult> {
		const stored = await this.require(runId);
		const { snapshot, header } = stored;
		if (header.executor !== this.executor.id)
			throw new EngineError(
				"conflict",
				`运行由执行器 ${header.executor} 创建，当前执行器是 ${this.executor.id}`,
			);
		if (snapshot.status === "completed")
			return {
				status: "completed",
				runId,
				variables: snapshot.context.variables,
				steps: snapshot.context.steps,
			};
		if (snapshot.status === "failed")
			return {
				status: "failed",
				runId,
				error: snapshot.failure ?? {
					code: "executor_failed",
					message: "运行已失败",
				},
			};
		const state: RunState = {
			runId,
			context: snapshot.context,
			seq: snapshot.seq,
			...(header.cwd === undefined ? {} : { cwd: header.cwd }),
		};
		if (snapshot.status === "awaiting_input" && snapshot.pending) {
			const renewed = renewStep(state.context);
			if (renewed) state.context = renewed;
		}
		await this.record(state, {
			type: "run.resumed",
			fromStatus: snapshot.status,
			...(snapshot.context.current === null
				? {}
				: { fromStepId: snapshot.context.current.stepId }),
		});
		return this.advance(state);
	}

	/** 终止运行：已终态时原样返回。停止事实是之后状态的唯一依据。 */
	async stop(runId: string, reason?: string): Promise<RunResult> {
		const stored = await this.require(runId);
		const { snapshot, header } = stored;
		if (snapshot.status === "completed")
			return {
				status: "completed",
				runId,
				variables: snapshot.context.variables,
				steps: snapshot.context.steps,
			};
		if (snapshot.status === "failed")
			return {
				status: "failed",
				runId,
				error: snapshot.failure ?? {
					code: "executor_failed",
					message: "运行已失败",
				},
			};
		const state: RunState = {
			runId,
			context: snapshot.context,
			seq: snapshot.seq,
			...(header.cwd === undefined ? {} : { cwd: header.cwd }),
		};
		await this.record(state, {
			type: "run.stopped",
			...(reason === undefined ? {} : { reason }),
		});
		await this.saveSnapshot(state, "interrupted");
		return { status: "interrupted", runId };
	}

	async pending(runId: string): Promise<PendingConfirm | undefined> {
		const stored = await this.store.load(runId);
		return stored?.snapshot.status === "awaiting_input"
			? stored.snapshot.pending
			: undefined;
	}

	/** 运行目录已存在即视为冲突，包括只有运行头、没有快照的半创建运行。 */
	private async exists(runId: string): Promise<boolean> {
		try {
			return (await this.store.load(runId)) !== undefined;
		} catch {
			return true;
		}
	}

	private async create(
		runId: string,
		header: RunHeader,
	): Promise<void> {
		try {
			await this.store.create(header);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new EngineError("conflict", `运行已存在: ${runId}`);
			throw error;
		}
	}

	private async require(runId: string) {
		const stored = await this.store.load(runId);
		if (!stored) throw new EngineError("not_found", `运行不存在: ${runId}`);
		return stored;
	}

	private async advance(state: RunState): Promise<RunResult> {
		try {
			while (true) {
				const step = state.context.current;
				if (step === null) {
					await this.record(state, {
						type: "run.completed",
						variables: state.context.variables,
						steps: state.context.steps,
					});
					await this.saveSnapshot(state, "completed");
					return {
						status: "completed",
						runId: state.runId,
						variables: state.context.variables,
						steps: state.context.steps,
					};
				}
				if (step.kind === "confirm") {
					const pending: PendingConfirm = {
						stepId: step.stepId,
						nodeRef: step.nodeRef,
						nodeName: step.name,
						message: step.prompt,
						options: step.options.map((option) => option.name),
					};
					await this.record(state, {
						type: "node.entered",
						stepId: step.stepId,
						nodeRef: step.nodeRef,
						nodeName: step.name,
						kind: "confirm",
						...(step.prompt === "" ? {} : { prompt: step.prompt }),
						variables: state.context.variables,
					});
					await this.record(state, {
						type: "confirm.pending",
						stepId: step.stepId,
						nodeRef: step.nodeRef,
						nodeName: step.name,
						message: pending.message,
						options: pending.options,
					});
					await this.saveSnapshot(state, "awaiting_input", pending);
					return { status: "awaiting_input", runId: state.runId, pending };
				}
				const failure =
					step.kind === "parallel"
						? await this.runParallel(state, step)
						: step.kind === "command"
							? await this.runCommand(state, step)
							: await this.runAgent(state, step);
				if (failure) return this.fail(state, failure);
				await this.saveSnapshot(state, "running");
			}
		} catch (error) {
			if (error instanceof EngineError) throw error;
			return this.fail(state, {
				code: "store_failed",
				message: messageOf(error),
				...(state.context.current === null
					? {}
					: { stepId: state.context.current.stepId }),
			});
		}
	}

	private async runAgent(
		state: RunState,
		step: Extract<NonNullable<FlowContext["current"]>, { kind: "agent" }>,
	): Promise<FlowFailure | undefined> {
		const visit = visits(state.context.steps, step.nodeRef) + 1;
		await this.record(state, {
			type: "node.entered",
			stepId: step.stepId,
			nodeRef: step.nodeRef,
			nodeName: step.name,
			kind: "agent",
			serve: visit,
			prompt: step.prompt,
			variables: state.context.variables,
		});
		let rejection: string | undefined;
		for (let attempt = 1; ; attempt += 1) {
			let reply: ExecutorReply;
			try {
				reply = await this.executor.prompt(step.name, {
					runId: state.runId,
					stepId: step.stepId,
					nodeRef: step.nodeRef,
					visit,
					text: step.prompt,
					outcomes: step.options,
					variables: state.context.variables,
					...(state.cwd === undefined ? {} : { cwd: state.cwd }),
					...(rejection === undefined ? {} : { rejection }),
				});
			} catch (error) {
				if (error instanceof ExecutorUnconfirmed)
					return {
						code: "executor_unconfirmed",
						message: messageOf(error),
						stepId: step.stepId,
						nodeRef: step.nodeRef,
					};
				return {
					code: "executor_failed",
					message: messageOf(error),
					stepId: step.stepId,
					nodeRef: step.nodeRef,
				};
			}
			try {
				this.submitStep(state, {
					stepId: step.stepId,
					outcome: reply?.outcome,
					...(reply?.variables === undefined
						? {}
						: { variables: reply.variables }),
				});
			} catch (error) {
				rejection = messageOf(error);
				await this.record(state, {
					type: "agent.rejected",
					stepId: step.stepId,
					nodeRef: step.nodeRef,
					serve: visit,
					reason: rejection,
				});
				if (attempt >= this.maxRejectedReplies)
					return {
						code: "rejected_results",
						message: `连续 ${attempt} 次提交了节点不允许的结果：${rejection}`,
						stepId: step.stepId,
						nodeRef: step.nodeRef,
					};
				continue;
			}
			await this.record(state, {
				type: "agent.replied",
				stepId: step.stepId,
				nodeRef: step.nodeRef,
				serve: visit,
				outcome: reply.outcome,
				...(reply.variables === undefined ? {} : { variables: reply.variables }),
			});
			await this.record(state, {
				type: "route.selected",
				stepId: step.stepId,
				nodeRef: step.nodeRef,
				outcome: reply.outcome,
				destination: destinationOf(state.context, step.nodeRef, reply.outcome),
				variables: state.context.variables,
			});
			return undefined;
		}
	}

	private async runCommand(
		state: RunState,
		step: CommandStep,
	): Promise<FlowFailure | undefined> {
		await this.record(state, {
			type: "node.entered",
			stepId: step.stepId,
			nodeRef: step.nodeRef,
			nodeName: step.name,
			kind: "command",
			variables: state.context.variables,
		});
		await this.record(state, {
			type: "command.started",
			stepId: step.stepId,
			nodeRef: step.nodeRef,
			nodeName: step.name,
			request: step.request,
			...(state.cwd === undefined ? {} : { cwd: state.cwd }),
		});
		const outcome = await this.executeCommand(state, step);
		if ("failure" in outcome) return outcome.failure;
		await this.record(state, {
			type: "command.finished",
			stepId: step.stepId,
			nodeRef: step.nodeRef,
			nodeName: step.name,
			exitCode: outcome.output.exitCode,
			stdout: outcome.output.stdout,
			stderr: outcome.output.stderr,
			...(outcome.variables === undefined ? {} : { variables: outcome.variables }),
		});
		try {
			this.submitStep(state, {
				stepId: step.stepId,
				outcome: "已执行",
				...(outcome.variables === undefined
					? {}
					: { variables: outcome.variables }),
			});
		} catch (error) {
			return {
				code: "rejected_results",
				message: messageOf(error),
				stepId: step.stepId,
				nodeRef: step.nodeRef,
			};
		}
		await this.record(state, {
			type: "route.selected",
			stepId: step.stepId,
			nodeRef: step.nodeRef,
			outcome: "已执行",
			destination: destinationOf(state.context, step.nodeRef, "已执行"),
			variables: state.context.variables,
		});
		return undefined;
	}

	private async runParallel(
		state: RunState,
		step: ParallelStep,
	): Promise<FlowFailure | undefined> {
		await this.record(state, {
			type: "node.entered",
			stepId: step.stepId,
			nodeRef: step.join.nodeRef,
			nodeName: step.join.name,
			kind: "parallel",
			variables: state.context.variables,
		});
		await this.record(state, {
			type: "parallel.entered",
			stepId: step.stepId,
			parallelRef: step.parallelRef,
			joinName: step.join.name,
			branches: step.branches.map(({ ref, nodeRef, name, request }) => ({
				ref,
				nodeRef,
				name,
				request,
			})),
		});
		for (const branch of step.branches)
			await this.record(state, {
				type: "command.started",
				stepId: branch.stepId,
				nodeRef: branch.nodeRef,
				nodeName: branch.name,
				parallelRef: step.parallelRef,
				request: branch.request,
				...(state.cwd === undefined ? {} : { cwd: state.cwd }),
			});
		const results = await Promise.all(
			step.branches.map(async (branch) => {
				const run = await this.executeCommand(state, {
					stepId: branch.stepId,
					nodeRef: branch.nodeRef,
					name: branch.name,
					request: branch.request,
					output: branch.request.output,
				});
				return [branch, run] as const;
			}),
		);
		const branches: Record<
			string,
			{ outcome: string; variables?: FlowVariables }
		> = {};
		for (const [branch, run] of results) {
			if ("failure" in run)
				return {
					...run.failure,
					stepId: branch.stepId,
					nodeRef: branch.nodeRef,
				};
			await this.record(state, {
				type: "command.finished",
				stepId: branch.stepId,
				nodeRef: branch.nodeRef,
				nodeName: branch.name,
				exitCode: run.output.exitCode,
				stdout: run.output.stdout,
				stderr: run.output.stderr,
				...(run.variables === undefined ? {} : { variables: run.variables }),
			});
			branches[branch.ref] = {
				outcome: "已执行",
				...(run.variables === undefined ? {} : { variables: run.variables }),
			};
		}
		try {
			this.submitStep(state, { stepId: step.stepId, branches });
		} catch (error) {
			return {
				code: "rejected_results",
				message: messageOf(error),
				stepId: step.stepId,
				nodeRef: step.join.nodeRef,
			};
		}
		return undefined;
	}

	private async executeCommand(
		state: RunState,
		step: Pick<CommandStep, "stepId" | "nodeRef" | "name" | "request" | "output">,
	): Promise<
		| {
				output: { exitCode: number; stdout: string; stderr: string };
				variables?: FlowVariables;
		  }
		| { failure: FlowFailure }
	> {
		let output: { exitCode: number; stdout: string; stderr: string };
		try {
			output = await this.executor.command({
				runId: state.runId,
				stepId: step.stepId,
				nodeRef: step.nodeRef,
				nodeName: step.name,
				request: step.request,
				...(state.cwd === undefined ? {} : { cwd: state.cwd }),
			});
		} catch (error) {
			return {
				failure: {
					code:
						error instanceof ExecutorUnconfirmed
							? "executor_unconfirmed"
							: "executor_failed",
					message: messageOf(error),
					stepId: step.stepId,
					nodeRef: step.nodeRef,
				},
			};
		}
		if (step.output !== "variables") return { output };
		try {
			const variables = readCommandVariables(output.stdout);
			return {
				output,
				...(variables === undefined ? {} : { variables }),
			};
		} catch (error) {
			return {
				failure: {
					code: "executor_failed",
					message: messageOf(error),
					stepId: step.stepId,
					nodeRef: step.nodeRef,
				},
			};
		}
	}

	/** 把一次回执交给 Flow Core 校验并选边，同时推进内存上下文。 */
	private submitStep(
		state: RunState,
		result:
			| { stepId: string; outcome?: string; variables?: FlowVariables }
			| {
					stepId: string;
					branches: Record<
						string,
						{ outcome: string; variables?: FlowVariables }
					>;
			  },
	): FlowContext {
		state.context = submit(state.context, result as never).context;
		return state.context;
	}

	private async fail(state: RunState, failure: FlowFailure): Promise<RunResult> {
		if (failure.code === "executor_unconfirmed") {
			await this.record(state, { type: "run.unconfirmed", ...failure });
			await this.saveSnapshot(state, "unconfirmed", undefined, failure);
			return { status: "unconfirmed", runId: state.runId, error: failure };
		}
		await this.record(state, { type: "run.failed", ...failure });
		await this.saveSnapshot(state, "failed", undefined, failure);
		return { status: "failed", runId: state.runId, error: failure };
	}

	private async record(state: RunState, event: LogEventPayload): Promise<void> {
		await this.store.append(state.runId, {
			...event,
			runId: state.runId,
			seq: state.seq + 1,
			at: this.now(),
		} as never);
		state.seq += 1;
	}

	private async saveSnapshot(
		state: RunState,
		status: RunSnapshot["status"],
		pending?: PendingConfirm,
		failure?: FlowFailure,
	): Promise<void> {
		await this.store.saveSnapshot(state.runId, {
			status,
			context: state.context,
			...(pending === undefined ? {} : { pending }),
			...(failure === undefined ? {} : { failure }),
			seq: state.seq,
			updatedAt: this.now(),
		});
	}
}

function visits(steps: CompletedStep[], nodeRef: string): number {
	return steps.filter((step) => step.nodeRef === nodeRef).length;
}

/** 选边后的去向。 */
function destinationOf(
	context: FlowContext,
	nodeRef: string,
	outcome: string,
): { kind: "node"; ref: string } | { kind: "finish" } | { kind: "parallel"; ref: string } {
	const route = context.flow.nodes[nodeRef]?.routes.find(
		(candidate) => candidate.name === outcome,
	);
	return route?.destination ?? { kind: "finish" };
}

/** 重新提问：只换 stepId，提示词与选项沿用同一份渲染结果。 */
function renewStep(context: FlowContext): FlowContext | undefined {
	const current = context.current;
	if (!current || current.kind === "parallel") return undefined;
	return {
		...context,
		current: { ...current, stepId: randomUUID() },
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type { StartRequest };
