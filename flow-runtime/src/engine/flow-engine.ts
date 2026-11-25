import { randomUUID } from "node:crypto";
import { ready, submit } from "ursi-flow-core";
import type { CompletedStep, FlowContext, FlowVariables } from "ursi-flow-core";
import type {
	Engine,
	EngineOptions,
	FlowFailure,
	PendingConfirm,
	RunResult,
	StartRequest,
} from "./contracts.ts";
import type {
	LogDestination,
	LogEvent,
	LogEventPayload,
	LogStore,
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
 * Flow 文件到最终结果的推进器。每一步做三件事：把渲染好的提示词交给执行器、
 * 校验回执后交给 Flow Core 选边、把过程写入日志。
 */
export class FlowEngine implements Engine {
	private readonly executor: EngineOptions["executor"];
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
		if (await this.store.load(runId))
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
		await this.store.create({
			runId,
			flowId: context.flow.id,
			...(request.flow.path === undefined ? {} : { flowPath: request.flow.path }),
			...(request.cwd === undefined ? {} : { cwd: request.cwd }),
			flowText: request.flow.text,
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
		const state: RunState = {
			runId,
			context: snapshot.context,
			seq: snapshot.seq,
			...(stored.header.cwd === undefined ? {} : { cwd: stored.header.cwd }),
		};
		const nodeRef = snapshot.context.current?.nodeRef ?? "";
		this.submitStep(state, stepId, result, undefined);
		await this.record(state, { type: "confirm.answered", stepId, result });
		await this.record(state, {
			type: "route.selected",
			stepId,
			nodeRef,
			outcome: result,
			destination: destinationOf(snapshot.context, nodeRef, result, nodeRef),
			variables: state.context.variables,
		});
		await this.saveSnapshot(state, "running");
		return this.advance(state);
	}

	/** 从持久化快照继续。等待中的运行重新给出待决确认，不重复执行节点。 */
	async resume(runId: string): Promise<RunResult> {
		const stored = await this.require(runId);
		const { snapshot, header } = stored;
		if (snapshot.status === "awaiting_input" && snapshot.pending)
			return { status: "awaiting_input", runId, pending: snapshot.pending };
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
			type: "run.resumed",
			...(snapshot.context.current === null
				? {}
				: { fromStepId: snapshot.context.current.stepId }),
		});
		return this.advance(state);
	}

	async pending(runId: string): Promise<PendingConfirm | undefined> {
		const stored = await this.store.load(runId);
		return stored?.snapshot.status === "awaiting_input"
			? stored.snapshot.pending
			: undefined;
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
				const nodeName = state.context.flow.nodes[step.nodeRef]?.name ?? step.nodeRef;
				const visit = visits(state.context.steps, step.nodeRef) + 1;
				if (step.kind === "confirm") {
					const pending: PendingConfirm = {
						stepId: step.stepId,
						nodeRef: step.nodeRef,
						nodeName,
						message: step.prompt,
						options: step.options.map((option) => option.name),
					};
					await this.record(state, {
						type: "confirm.pending",
						stepId: step.stepId,
						nodeRef: step.nodeRef,
						nodeName,
						message: pending.message,
						options: pending.options,
					});
					await this.saveSnapshot(state, "awaiting_input", pending);
					return { status: "awaiting_input", runId: state.runId, pending };
				}
				await this.record(state, {
					type: "node.entered",
					stepId: step.stepId,
					nodeRef: step.nodeRef,
					nodeName,
					kind: step.kind,
					serve: visit,
					prompt: step.prompt,
					variables: state.context.variables,
				});
				let rejection: string | undefined;
				for (let attempt = 1; ; attempt += 1) {
					let reply: unknown;
					try {
						reply = await this.executor.prompt(nodeName, {
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
						return this.fail(state, {
							code: "executor_failed",
							message: messageOf(error),
							stepId: step.stepId,
							nodeRef: step.nodeRef,
						});
					}
					try {
						this.submitStep(state, step.stepId, outcomeOf(reply), variablesOf(reply));
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
							return this.fail(state, {
								code: "rejected_results",
								message: `连续 ${attempt} 次提交了节点不允许的结果：${rejection}`,
								stepId: step.stepId,
								nodeRef: step.nodeRef,
							});
						continue;
					}
					const outcome = outcomeOf(reply);
					await this.record(state, {
						type: "agent.replied",
						stepId: step.stepId,
						nodeRef: step.nodeRef,
						serve: visit,
						outcome,
						...(variablesOf(reply) === undefined
							? {}
							: { variables: variablesOf(reply) as FlowVariables }),
					});
					await this.record(state, {
						type: "route.selected",
						stepId: step.stepId,
						nodeRef: step.nodeRef,
						outcome,
						destination: destinationOf(
							state.context,
							step.nodeRef,
							outcome,
							step.nodeRef,
						),
						variables: state.context.variables,
					});
					await this.saveSnapshot(state, "running");
					break;
				}
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

	/** 把一次回执交给 Flow Core 校验并选边，同时推进内存上下文。 */
	private submitStep(
		state: RunState,
		stepId: string,
		outcome: string,
		variables: FlowVariables | undefined,
	): FlowContext {
		state.context = submit(state.context, {
			stepId,
			outcome,
			...(variables === undefined ? {} : { variables }),
		}).context;
		return state.context;
	}

	private async fail(state: RunState, failure: FlowFailure): Promise<RunResult> {
		await this.record(state, { type: "run.failed", ...failure });
		await this.saveSnapshot(state, "failed", undefined, failure);
		return { status: "failed", runId: state.runId, error: failure };
	}

	private async record(state: RunState, event: LogEventPayload): Promise<void> {
		const wire: LogEvent = {
			...event,
			runId: state.runId,
			seq: state.seq + 1,
			at: this.now(),
		};
		await this.store.append(state.runId, wire);
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

function outcomeOf(reply: unknown): string {
	return (reply as { outcome?: unknown } | null)?.outcome as string;
}

function variablesOf(reply: unknown): FlowVariables | undefined {
	return (reply as { variables?: FlowVariables } | null)?.variables;
}

function visits(steps: CompletedStep[], nodeRef: string): number {
	return steps.filter((step) => step.nodeRef === nodeRef).length;
}

/** 选边后的去向。 */
function destinationOf(
	context: FlowContext,
	nodeRef: string,
	outcome: string,
	_sourceNodeRef?: string,
): LogDestination {
	const route = context.flow.nodes[nodeRef]?.routes.find(
		(candidate) => candidate.name === outcome,
	);
	return route?.destination ?? { kind: "finish" };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
