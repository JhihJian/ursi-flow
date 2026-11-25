import { createHash, randomUUID } from "node:crypto";
import {
	initializeVariables,
	pickDeclaredVariables,
	renderPrompt,
	requireOutcomeRoute,
	RouteNotFoundError,
	validateOutcomeVariables,
	VariableReferenceError,
} from "ursi-flow-core/runtime";
import { AttemptUnconfirmed, AwaitingInput } from "../contracts/extensions.ts";
import type {
	AgentRunExecutor,
	FlowExecutionExtensions,
} from "../contracts/extensions.ts";
import type {
	AgentProfileReference,
	FlowDefinition,
	FlowDestination,
	FlowError,
	FlowErrorCategory,
	FlowNode,
	FlowObservationEvent,
	FlowObservationPublisherApi,
	FlowPackage,
	FlowReferenceAction,
	FlowResourceContext,
	FlowRunInput,
	FlowRunRecord,
	FlowValue,
	FlowVariables,
	NodeOutcome,
	NodeRunRecord,
	NodeRunSource,
	ParallelRoundRecord,
	RouteDecisionRecord,
	RunFactCommit,
	RunRecoveryRecord,
	RunStore,
} from "../contracts/types.ts";
import { validateVariables } from "../contracts/variables.ts";
import {
	resolveCommandResources,
	resolvePromptResources,
} from "../definition/flow-loader.ts";
import {
	FLOW_REFERENCE_FAILURE_RESULT,
	FLOW_REFERENCE_SUCCESS_RESULT,
	renderCommandRequest,
	renderTemplate,
} from "../definition/parser.ts";
import { snapshotFlowDefinition } from "../definition/snapshot.ts";
import { runtimeToolsForNode } from "./preflight.ts";

type FactChanges = Omit<RunFactCommit, "run" | "expectedSequence">;

type ObservationSpec = {
	type: FlowObservationEvent["type"];
	summary: string;
	nodeRunId?: string;
	nodeName?: string;
	nodeRef?: string;
	parallelRoundId?: string;
	result?: string;
	destination?: FlowDestination;
	nodeStatus?: NodeRunRecord["status"];
	parallelStatus?: ParallelRoundRecord["status"];
};

export class FlowCoordinator {
	private readonly flow: FlowDefinition;
	private readonly store: RunStore;
	private readonly agentModel: AgentRunExecutor;
	private readonly extensions: FlowExecutionExtensions;
	private readonly publisher?: FlowObservationPublisherApi;
	private readonly resources?: FlowResourceContext;
	/** 引用闭包：标识到已加载子 Flow 的映射，供执行Flow 节点与更深层引用使用。 */
	private readonly references?: ReadonlyMap<string, FlowPackage>;
	private readonly onObservationError: (
		error: unknown,
		event: FlowObservationEvent,
	) => void;
	private writes = Promise.resolve();

	constructor(
		flow: FlowDefinition,
		store: RunStore,
		agentModel: AgentRunExecutor,
		extensions: FlowExecutionExtensions = {},
		publisher?: FlowObservationPublisherApi,
		onObservationError: (
			error: unknown,
			event: FlowObservationEvent,
		) => void = () => undefined,
		resources?: FlowResourceContext,
		references?: ReadonlyMap<string, FlowPackage>,
	) {
		this.flow = flow;
		this.store = store;
		this.agentModel = agentModel;
		this.extensions = extensions;
		this.publisher = publisher;
		this.onObservationError = onObservationError;
		this.resources = resources;
		this.references = references;
	}

	async run(
		input: FlowRunInput,
		options: {
			runId?: string;
			existingAgentReference?: string;
			cwd?: string;
			flowPath?: string;
			sessionReference?: string;
			parentRunId?: string;
			parentNodeRunId?: string;
		} = {},
	): Promise<FlowRunRecord> {
		await this.agentModel.preflight(this.flow, {
			execution: this.extensions,
			references: this.references,
			cwd: options.cwd,
			sessionReference: options.existingAgentReference,
		});
		let variables: FlowVariables;
		try {
			variables = initializeVariables(this.flow.variables ?? {}, input.variables ?? {});
		} catch (error) {
			if (error instanceof VariableReferenceError)
				throw new FlowRuntimeError("variable_reference", error.message);
			throw error;
		}
		const initialNode = this.flow.nodes.get(this.flow.startNodeRef);
		if (
			initialNode?.action.kind === "新建Agent" &&
			initialNode.action.profile &&
			/\{(?:var|input)\./.test(
				JSON.stringify(initialNode.action.profile.params ?? {}),
			)
		) {
			await this.agentModel.extensions.assembly?.preflight(
				{
					profile: renderAgentProfile(
						initialNode.action.profile,
						undefined,
						variables,
					),
				},
				options.cwd,
			);
		}
		if (options.existingAgentReference) {
			for (const first of this.firstAgentNodes([
				{ kind: "node", ref: this.flow.startNodeRef },
			])) {
				if (
					first.action.kind !== "新建Agent" &&
					first.action.kind !== "复用Agent"
				)
					continue;
				const deferred =
					first.ref !== this.flow.startNodeRef &&
					/\{(?:var|input)\./.test(
						JSON.stringify(first.action.profile?.params ?? {}),
					);
				const profile = deferred
					? undefined
					: renderAgentProfile(
							first.action.profile,
							undefined,
							variables,
						);
				await this.agentModel.extensions.continuity?.preflight?.({
					sessionReference: options.existingAgentReference,
					cwd: options.cwd,
					...(profile ? { profile } : {}),
					runtimeToolDefinitions: runtimeToolsForNode(this.flow, first),
				});
			}
		}
		const initialInput: FlowValue = {};
		const run: FlowRunRecord = {
			id: options.runId ?? randomUUID(),
			flowId: this.flow.id,
			flowVersion: fingerprintFlow(this.flow, this.references),
			variables,
			status: "running",
			phase: "starting",
			sequence: 1,
			historyCompleteness: "complete",
			startedAt: now(),
			flowPath: options.flowPath,
			definition: snapshotFlowDefinition(
				this.flow,
				fingerprintFlow(this.flow, this.references),
			),
			cwd: options.cwd,
			agentNodeRunId: null,
			sessionReference: options.sessionReference,
			parentRunId: options.parentRunId,
			parentNodeRunId: options.parentNodeRunId,
			currentNodeRef: this.flow.startNodeRef,
			currentInput: initialInput,
		};
		await this.store.createRun(run);
		const startNodeName =
			this.flow.nodes.get(this.flow.startNodeRef)?.name ??
			this.flow.startNodeRef;
		this.publishObservation(run, {
			type: "run.started",
			nodeRef: run.currentNodeRef,
			nodeName: startNodeName,
			summary: `Flow 运行已开始，首节点为“${startNodeName}”`,
		});
		return this.continueRun(
			run,
			this.flow.startNodeRef,
			initialInput,
			options,
			{
				kind: "start",
			},
			false,
			undefined,
			undefined,
			true,
		);
	}

	/** Continue a persisted Run. Incomplete Agent work becomes a new NodeRun. */
	async resume(
		runId: string,
		options: { existingAgentReference?: string; cwd?: string } = {},
	): Promise<FlowRunRecord> {
		const run = await this.store.getRun(runId);
		if (!run) throw new Error(`Flow 运行不存在: ${runId}`);
		if (run.parentRunId)
			throw new Error(
				`子 Flow 运行不支持直接恢复，请恢复父运行: ${run.parentRunId}`,
			);
		return this.resumeRun(runId, options);
	}

	async resumeChild(
		runId: string,
		parentRunId: string,
		parentNodeRunId: string,
		options: { cwd?: string } = {},
	): Promise<FlowRunRecord> {
		const run = await this.store.getRun(runId);
		if (
			!run ||
			run.parentRunId !== parentRunId ||
			run.parentNodeRunId !== parentNodeRunId
		)
			throw new Error(`子 Flow 运行的父身份不匹配: ${runId}`);
		return this.resumeRun(runId, options);
	}

	/** 父级续接路径使用的恢复入口：子 Run 只随父 Run 恢复，不检查直接恢复。 */
	private async resumeRun(
		runId: string,
		options: { existingAgentReference?: string; cwd?: string } = {},
	): Promise<FlowRunRecord> {
		const run = await this.store.getRun(runId);
		if (!run) throw new Error(`Flow 运行不存在: ${runId}`);
		if (run.flowId !== this.flow.id)
			throw new Error(`Flow 运行不属于当前 Flow: ${runId}`);
		if (
			run.historyCompleteness === "complete" &&
			run.flowVersion !== fingerprintFlow(this.flow, this.references)
		) {
			throw new Error(`Flow 版本与运行记录不匹配: ${runId}`);
		}
		if (run.status !== "running" && run.status !== "interrupted") {
			throw new Error(`Flow 运行不可恢复: ${runId}`);
		}

		const nodeRuns = await this.store.listNodeRuns(run.id);
		const current = run.currentNodeRunId
			? nodeRuns.find((record) => record.id === run.currentNodeRunId)
			: [...nodeRuns]
					.reverse()
					.find(
						(record) =>
							record.nodeRef === run.currentNodeRef &&
							record.status === "running",
					);
		const nodeRef = current?.nodeRef ?? run.currentNodeRef;
		const node = nodeRef ? this.flow.nodes.get(nodeRef) : undefined;
		if (!run.currentParallelRoundId && (!nodeRef || !node))
			throw new Error(`Flow 运行缺少可恢复的执行位置: ${runId}`);
		const reference = options.existingAgentReference ?? run.sessionReference;
		const boundNode =
			run.agentNodeRunId === undefined
				? [...nodeRuns]
						.reverse()
						.find(
							(record) =>
								reference && record.session?.sessionReference === reference,
						)?.id
				: run.agentNodeRunId;
		const restoreCurrent =
			node?.action.kind === "复用Agent" ||
			(node?.action.kind === "新建Agent" &&
				!!reference &&
				(options.existingAgentReference !== undefined ||
					boundNode === undefined ||
					boundNode === current?.id));
		let restorationTargets: FlowNode[] = [];
		if (run.currentParallelRoundId) {
			const round = (await this.store.listParallelRounds(run.id)).find(
				(entry) => entry.id === run.currentParallelRoundId,
			);
			if (!round) throw new Error("Flow 缺少并行恢复事实");
			const unsafeCommand = Object.values(round.branchNodeRunIds).some((id) => {
				const record = nodeRuns.find((entry) => entry.id === id);
				return record && record.status !== "completed";
			});
			if (!unsafeCommand)
				restorationTargets = this.firstAgentNodes([
					{ kind: "parallel", ref: round.parallelRef },
				]).filter((target) => target.action.kind === "复用Agent");
		} else if (current?.status === "completed" && current.outcome && node) {
			const destination = node.successors.get(current.outcome.result);
			restorationTargets = destination
				? this.firstAgentNodes([destination]).filter(
						(target) => target.action.kind === "复用Agent",
					)
				: [];
		} else if (node) {
			restorationTargets = restoreCurrent
				? [node]
				: node.action.kind === "执行Flow"
					? this.firstAgentNodes([...node.successors.values()]).filter(
							(target) => target.action.kind === "复用Agent",
						)
					: [];
		}
		const needsSession = restorationTargets.length > 0;
		const resumedOptions = {
			existingAgentReference: needsSession ? reference : undefined,
			cwd: options.cwd ?? run.cwd,
		};
		await this.agentModel.preflight(this.flow, {
			execution: this.extensions,
			references: this.references,
			cwd: resumedOptions.cwd,
			sessionReference: resumedOptions.existingAgentReference,
		});
		if (needsSession && !reference)
			throw new Error("恢复所需的 Agent Session 不存在");
		if (resumedOptions.existingAgentReference) {
			const profile =
				restoreCurrent &&
				node?.action.kind === "新建Agent" &&
				current &&
				current.status !== "completed"
					? renderAgentProfile(
							node.action.profile,
							current.enteredFrom.kind === "start" ? undefined : current.input,
							run.variables ?? {},
						)
					: run.agentProfile;
			for (const target of restorationTargets)
				await this.agentModel.extensions.continuity?.preflight?.({
					sessionReference: resumedOptions.existingAgentReference,
					cwd: resumedOptions.cwd,
					...(profile ? { profile } : {}),
					expectedAssembly: run.agentAssembly,
					runtimeToolDefinitions: runtimeToolsForNode(this.flow, target),
				});
		}
		if (current?.attemptId && (current.status === "running" || current.status === "interrupted")) {
			if (!this.agentModel.allocateAttemptId) throw Error("恢复需要原平台执行器");
			const round = run.currentParallelRoundId ? await this.requireParallelRound(run, run.currentParallelRoundId) : undefined;
			await this.recordRecovery(run, current.id, "inspect_attempt", "按已保存的尝试 ID 核实节点结果");
			const result = await this.executePreparedNode(run, current, resumedOptions.cwd, new Map(), round, undefined, true, true);
			return this.continueRun(run, current.nodeRef, current.input, resumedOptions, current.enteredFrom, false, result);
		}
		if (run.currentParallelRoundId) {
			const resumeNodeRef = run.currentNodeRef ?? this.flow.startNodeRef;
			await this.agentModel.start(
				run.id,
				resumedOptions.existingAgentReference,
				resumedOptions.cwd,
				run.agentAssembly,
				run.agentProfile,
				false,
			);
			return this.continueRun(
				run,
				resumeNodeRef,
				run.currentInput ?? {},
				resumedOptions,
				{ kind: "start" },
				true,
			);
		}

		if (!nodeRef || !node) throw new Error(`工作节点不存在: ${runId}`);
		if (current?.status === "running" || current?.status === "interrupted") {
			if (node.action.kind === "执行Flow") {
				return this.resumeFlowReferenceNode(run, current, node, resumedOptions);
			}
			await this.interruptNode(run, current);
			if (node.action.kind === "执行自定义命令") {
				return this.failInterruptedCommand(run, current);
			}
			await this.agentModel.start(
				run.id,
				restoreCurrent ? resumedOptions.existingAgentReference : undefined,
				resumedOptions.cwd,
				run.agentAssembly,
				run.agentProfile,
				restoreCurrent && node.action.kind === "新建Agent",
			);
			return this.continueRun(
				run,
				nodeRef,
				current.input,
				resumedOptions,
				{ kind: "recovery", nodeRunId: current.id },
				true,
				undefined,
				current,
			);
		}

		await this.agentModel.start(
			run.id,
			resumedOptions.existingAgentReference,
			resumedOptions.cwd,
			run.agentAssembly,
			run.agentProfile,
			false,
		);
		if (current?.status === "completed" && current.outcome) {
			await this.recordRecovery(
				run,
				current.id,
				"continue_routing",
				"从已完成节点继续路由",
			);
			return this.continueRun(
				run,
				nodeRef,
				current.input,
				resumedOptions,
				current.enteredFrom,
				true,
				{ record: current, outcome: current.outcome },
			);
		}
		await this.agentModel.end(run.id);
		throw new Error(`Flow 运行没有可恢复的节点事实: ${runId}`);
	}

	/** Commands/child flows preserve this Agent; a new Agent ends the old binding's reachability. */
	private firstAgentNodes(
		destinations: readonly FlowDestination[],
	): FlowNode[] {
		const seen = new Set<string>(),
			agents: FlowNode[] = [];
		const visit = (destination: FlowDestination): void => {
			if (destination.kind === "finish" || seen.has(destination.ref)) return;
			seen.add(destination.ref);
			if (destination.kind === "parallel") {
				const parallel = this.flow.parallels.get(destination.ref);
				if (parallel) visit({ kind: "node", ref: parallel.joinRef });
				return;
			}
			const node = this.flow.nodes.get(destination.ref);
			if (!node) return;
			if (
				node.action.kind === "新建Agent" ||
				node.action.kind === "复用Agent"
			) {
				agents.push(node);
				return;
			}
			for (const successor of node.successors.values()) visit(successor);
		};
		for (const destination of destinations) visit(destination);
		return agents;
	}

	private async continueRun(
		run: FlowRunRecord,
		initialNodeRef: string,
		initialInput: FlowValue,
		options: { existingAgentReference?: string; cwd?: string },
		initialSource: NodeRunSource,
		agentStarted = false,
		initialResult?: { record: NodeRunRecord; outcome: NodeOutcome },
		retryOf?: NodeRunRecord,
		newInputSemantics = true,
	): Promise<FlowRunRecord> {
		let nodeRef = initialNodeRef;
		let input = initialInput;
		let source = initialSource;
		let result = initialResult;
		let retry = retryOf;
		let branchOutcomes = new Map<string, FlowVariables>();
		try {
			if (!agentStarted)
				await this.agentModel.start(
					run.id,
					options.existingAgentReference,
					options.cwd,
					run.agentAssembly,
					run.agentProfile,
				);
			while (true) {
				if (run.currentParallelRoundId) {
					const round = await this.requireParallelRound(
						run,
						run.currentParallelRoundId,
					);
					const parallel = this.flow.parallels.get(round.parallelRef);
					if (!parallel)
						throw new FlowRuntimeError(
							"parallel_configuration",
							`并行开始点不存在: ${round.parallelRef}`,
						);
					const branchResults = await this.executeParallel(
						run,
						round,
						parallel,
						options.cwd,
					);
					nodeRef = parallel.joinRef;
					input = branchResults.input;
					branchOutcomes = branchResults.outcomes;
					source = {
						kind: "parallel",
						parallelRoundId: round.id,
						branchNodeRunIds: Object.values(round.branchNodeRunIds),
					};
					result = undefined;
					retry = undefined;
				}

				const executed =
					result ??
					(await this.executeNode(
						run,
						nodeRef,
						input,
						options.cwd,
						branchOutcomes,
						source,
						retry,
						newInputSemantics,
					));
				result = undefined;
				retry = undefined;
				branchOutcomes = new Map();

				let destination: FlowDestination;
				try {
					destination = this.destination(nodeRef, executed.outcome.result);
				} catch (error) {
					await this.failNode(
						run,
						executed.record,
						toFlowError(error, "route_not_found"),
					);
					throw error;
				}

				const nextRoundId =
					destination.kind === "parallel" ? randomUUID() : undefined;
				const decision = await this.selectRoute(
					run,
					executed.record,
					executed.outcome.result,
					destination,
					nextRoundId,
				);
				if (destination.kind === "finish") {
					await this.completeRun(run);
					return clone(run);
				}
				if (destination.kind === "node") {
					nodeRef = destination.ref;
					input = extractNextInput(
						this.flow.nodes.get(executed.record.nodeRef),
						executed.outcome,
					);
					source = {
						kind: "route",
						routeDecisionId: decision.id,
						sourceNodeRunId: executed.record.id,
					};
					continue;
				}
				await this.enterParallel(
					run,
					destination.ref,
					extractNextInput(
						this.flow.nodes.get(executed.record.nodeRef),
						executed.outcome,
					),
					executed.record.id,
					nextRoundId ?? randomUUID(),
				);
			}
		} catch (error) {
			if (error instanceof AttemptUnconfirmed) throw error;
			if (error instanceof AwaitingInput) return clone(run);
			if (run.status !== "failed") {
				await this.failRun(run, toFlowError(error, "unknown"));
			}
			throw error;
		} finally {
			await this.agentModel.end(run.id);
		}
	}

	private async executeParallel(
		run: FlowRunRecord,
		round: ParallelRoundRecord,
		parallel: { branches: string[]; joinRef: string },
		cwd?: string,
	): Promise<{ input: FlowValue; outcomes: Map<string, FlowVariables> }> {
		const existing = new Map(
			(await this.store.listNodeRuns(run.id)).map((record) => [
				record.id,
				record,
			]),
		);
		const branchRecords = new Map<string, NodeRunRecord>();
		for (const branchRef of parallel.branches) {
			const existingId = round.branchNodeRunIds[branchRef];
			const record = existingId ? existing.get(existingId) : undefined;
			if (record) {
				if (record.status !== "completed") {
					await this.interruptNode(run, record, round, branchRef);
					return this.failInterruptedCommand(run, record, round);
				}
				branchRecords.set(branchRef, record);
				continue;
			}
			branchRecords.set(
				branchRef,
				await this.startNode(
					run,
					branchRef,
					round.input,
					{
						kind: "parallel",
						parallelRoundId: round.id,
					},
					undefined,
					round,
					branchRef,
				),
			);
		}

		if (!this.extensions.parallel)
			throw new Error("Flow 缺少扩展能力: Parallel Executor");
		const completed = await this.extensions.parallel.execute(
			parallel.branches.map((branchRef) => async () => {
				const record = branchRecords.get(branchRef);
				if (!record) throw new Error(`并行分支缺少执行记录: ${branchRef}`);
				if (record.status === "completed" && record.outcome) {
					return [branchRef, record.outcome.variables ?? {}] as const;
				}
				const result = await this.executePreparedNode(
					run,
					record,
					cwd,
					new Map(),
					round,
					branchRef,
				);
				const destination = this.destination(branchRef, result.outcome.result);
				await this.selectRoute(
					run,
					result.record,
					result.outcome.result,
					destination,
					undefined,
					false,
				);
				return [branchRef, result.outcome.variables ?? {}] as const;
			}),
		);
		const persistedRound = (await this.store.listParallelRounds(run.id)).find(
			(record) => record.id === round.id,
		);
		if (persistedRound) {
			const finalizedRound = clone(persistedRound);
			for (const branchRef of parallel.branches) {
				finalizedRound.branchStatuses[branchRef] = "completed";
			}
			const globalPatches = Object.fromEntries(
				Object.entries(finalizedRound.variablePatches ?? {}).map(
					([branch, values]) => [
						branch,
						Object.fromEntries(
							Object.entries(values).filter(([name]) =>
								Object.hasOwn(this.flow.variables ?? {}, name),
							),
						),
					],
				),
			);
			const mergedVariables = mergeParallelVariables(
				run.variables ?? {},
				globalPatches,
			);
			await this.commit(
				run,
				(next) => {
					next.variables = mergedVariables;
					return { parallelRounds: [finalizedRound] };
				},
				[
					{
						type: "parallel.completed",
						parallelRoundId: finalizedRound.id,
						parallelStatus: "completed",
						summary: `并行轮次“${finalizedRound.parallelRef}”的分支已全部完成，准备汇合`,
					},
				],
			);
			replaceObject(round, finalizedRound);
		}
		return { input: round.input, outcomes: new Map(completed) };
	}

	private async executeNode(
		run: FlowRunRecord,
		nodeRef: string,
		input: FlowValue,
		cwd: string | undefined,
		branchOutcomes: ReadonlyMap<string, FlowVariables>,
		source: NodeRunSource,
		retryOf?: NodeRunRecord,
		newInputSemantics = false,
	): Promise<{ record: NodeRunRecord; outcome: NodeOutcome }> {
		const round =
			source.kind === "parallel"
				? await this.requireParallelRound(run, source.parallelRoundId)
				: undefined;
		const record = await this.startNode(
			run,
			nodeRef,
			input,
			source,
			retryOf,
			round,
		);
		return this.executePreparedNode(
			run,
			record,
			cwd,
			branchOutcomes,
			round,
			undefined,
			newInputSemantics,
		);
	}

	private async startNode(
		run: FlowRunRecord,
		nodeRef: string,
		input: FlowValue,
		source: NodeRunSource,
		retryOf?: NodeRunRecord,
		round?: ParallelRoundRecord,
		branchRef?: string,
	): Promise<NodeRunRecord> {
		const node = this.flow.nodes.get(nodeRef);
		if (!node) {
			const error = new FlowRuntimeError(
				"route_not_found",
				`工作节点不存在: ${nodeRef}`,
			);
			await this.failRun(run, toFlowError(error, "route_not_found"));
			throw error;
		}
		const record: NodeRunRecord = {
			id: randomUUID(),
			runId: run.id,
			sequence: 0,
			nodeName: node.name,
			nodeRef,
			actionKind: node.action.kind,
			input,
			status: "running",
			startedAt: now(),
			enteredFrom: source,
			retryOf: retryOf?.id,
			parallelRoundId: round?.id,
		};
		if (node.action.kind === "新建Agent" && this.agentModel.allocateAttemptId)
			record.attemptId = this.agentModel.allocateAttemptId();
		if (node.action.kind === "执行Flow") record.childRunId = randomUUID();
		const recovery =
			source.kind === "recovery" && retryOf
				? {
						id: randomUUID(),
						runId: run.id,
						sequence: 0,
						interruptedNodeRunId: retryOf.id,
						strategy: "retry_agent" as const,
						resumedAt: now(),
						summary: `从中断节点“${displayNodeName(retryOf)}”创建新的 Agent 访问`,
					}
				: undefined;
		await this.commit(
			run,
			(next, sequence) => {
				record.sequence = sequence;
				if (recovery) recovery.sequence = sequence;
				next.status = "running";
				next.phase = "executing_node";
				delete next.error;
				next.currentNodeRef = nodeRef;
				next.currentInput = input;
				next.currentNodeRunId = record.id;
				delete next.currentParallelRoundId;
				if (round) {
					if (branchRef) {
						round.branchNodeRunIds[branchRef] = record.id;
						round.branchStatuses[branchRef] = "running";
						next.phase = "waiting_parallel";
						delete next.currentNodeRef;
						delete next.currentNodeRunId;
						next.currentParallelRoundId = round.id;
					} else {
						round.status = "joining";
						round.joinNodeRunId = record.id;
						round.joinInput = input;
						next.currentParallelRoundId = round.id;
					}
				}
				return {
					nodeRuns: [record],
					parallelRounds: round ? [round] : undefined,
					recoveries: recovery ? [recovery] : undefined,
				};
			},
			[
				...(recovery
					? [
							{
								type: "run.resumed" as const,
								nodeRunId: record.id,
								nodeName: record.nodeName,
								nodeRef,
								summary: `Flow 运行已恢复，创建节点“${displayNodeName(record)}”的新访问`,
							},
						]
					: []),
				{
					type: "node.started",
					nodeRunId: record.id,
					nodeName: record.nodeName,
					nodeRef,
					summary: `节点“${displayNodeName(record)}”开始执行`,
				},
			],
		);
		return record;
	}

	private async executePreparedNode(
		run: FlowRunRecord,
		record: NodeRunRecord,
		cwd: string | undefined,
		branchOutcomes: ReadonlyMap<string, FlowVariables>,
		round?: ParallelRoundRecord,
		branchRef?: string,
		newInputSemantics = false,
		inspectOnly = false,
	): Promise<{ record: NodeRunRecord; outcome: NodeOutcome }> {
		const node = this.flow.nodes.get(record.nodeRef);
		if (!node) {
			const error = new FlowRuntimeError(
				"route_not_found",
				`工作节点不存在: ${record.nodeRef}`,
			);
			await this.failNode(
				run,
				record,
				toFlowError(error, "route_not_found"),
				round,
				branchRef,
			);
			throw error;
		}
		try {
			let outcome: NodeOutcome | undefined;
			const nodeInput =
				newInputSemantics && record.enteredFrom.kind === "start"
					? undefined
					: record.input;
			if (node.action.kind === "执行Flow") {
				outcome = await this.executeFlowReference(
					run,
					record,
					node,
					cwd,
					nodeInput,
				);
			} else if (node.action.kind === "执行自定义命令") {
				const renderedRequest = renderCommandRequest(
					node.action.request,
					nodeInput,
					branchOutcomes,
					run.variables ?? {},
				);
				const request = resolveCommandResources(
					{ ...renderedRequest, cwd },
					this.resources,
				);
				if (!this.extensions.command)
					throw new Error("Flow 缺少扩展能力: Command Executor");
				const commandResult = await this.extensions.command.execute(request);
				const structured =
					node.action.request.output === "variables"
						? parseCommandVariables(commandResult.stdout)
						: undefined;
				outcome = {
					result: "已执行",
					variables: structured?.variables,
				};
				record.commandResult = commandResult;
			} else if (node.action.kind === "confirm") {
				outcome = await this.suspendForConfirm(run, record, node, nodeInput);
			} else {
				const profile = renderAgentProfile(
					node.action.profile,
					nodeInput,
					run.variables ?? {},
				);
				const result = await this.agentModel.executeNode({
					runId: run.id,
					action: node.action.kind,
					nodeExecutionReference: record.id,
					attemptId: record.attemptId,
					inspectOnly,
					...(node.action.kind === "新建Agent" && node.action.executor
						? { executor: node.action.executor }
						: {}),
					profile,
					prompt: renderAgentPrompt(
						node.action.prompt,
						nodeInput,
						node,
						this.resources,
						run.variables ?? {},
					),
					allowedVariables: new Map(
						[...node.results.keys()].map((result) => [
							result,
							[
								...Object.keys(this.flow.variables ?? {}),
								...Object.keys(declaredResultVariables(node, result)),
							],
						]),
					),
					outcomes: [...node.results].map(([name, description]) => ({
						name,
						description,
					})),
					cwd,
					onConnection: async (connection) => {
						record.agentAssembly = connection.assembly;
						record.session = {
							id: record.id,
							sessionReference: connection.sessionReference,
						};
						await this.commit(run, (next) => {
							next.sessionReference = connection.sessionReference;
							next.agentAssembly = connection.assembly;
							next.agentNodeRunId = record.id;
							if (node.action.kind === "新建Agent") next.agentProfile = profile;
							return { nodeRuns: [record] };
						});
					},
				});
				outcome = result.outcome;
				record.session = result.session;
			}
			if (!outcome)
				throw new FlowRuntimeError(
					"outcome_validation",
					`节点 ${node.ref} 未产生结果`,
				);
			await this.completeNode(run, record, outcome, round, branchRef);
			return { record, outcome };
		} catch (error) {
			if (error instanceof AttemptUnconfirmed) throw error;
			if (error instanceof AwaitingInput) throw error;
			if (record.status !== "failed") {
				await this.failNode(
					run,
					record,
					toFlowError(
						error,
						node.action.kind === "执行自定义命令"
							? "command_execution"
							: node.action.kind === "执行Flow"
								? "flow_reference"
								: "agent_execution",
					),
					round,
					branchRef,
				);
			}
			throw error;
		}
	}

	/** 执行Flow 节点：把输入交给子 Flow 作为独立 Run 运行到终态，再映射回节点结果。 */
	private async executeFlowReference(
		run: FlowRunRecord,
		record: NodeRunRecord,
		node: FlowNode,
		cwd: string | undefined,
		_input: FlowValue | undefined,
	): Promise<NodeOutcome> {
		if (node.action.kind !== "执行Flow")
			throw new FlowRuntimeError(
				"flow_reference",
				`节点 ${node.ref} 不是 Flow 引用节点`,
			);
		const child = await this.startChildRun(
			run,
			record,
			node.action,
			cwd,
			_input,
		);
		return this.childOutcome(node, child);
	}

	private async startChildRun(
		run: FlowRunRecord,
		record: NodeRunRecord,
		action: FlowReferenceAction,
		cwd: string | undefined,
		input: FlowValue | undefined,
	): Promise<FlowRunRecord> {
		const pkg = this.references?.get(action.flow);
		if (!pkg)
			throw new FlowRuntimeError(
				"flow_reference",
				`被引用的 Flow 未在闭包中加载: ${action.flow}`,
			);
		const childInput = {
			variables: renderTemplate(action.inputs ?? {}, {
				input,
				variables: run.variables ?? {},
			}) as FlowVariables,
		};
		const childRunId = record.childRunId ?? randomUUID();
		try {
			if (!this.extensions.childFlow)
				throw new Error("Flow 缺少扩展能力: Child Flow Executor");
			return await this.extensions.childFlow.execute({
				flow: pkg,
				references: this.references ?? new Map(),
				input: childInput,
				runId: childRunId,
				cwd,
				parentRunId: run.id,
				parentNodeRunId: record.id,
			});
		} catch (error) {
			if (error instanceof AttemptUnconfirmed) throw error;
			const persisted = await this.store.getRun(childRunId);
			if (persisted) return persisted;
			throw error;
		}
	}

	/** 子 Run 终态映射：completed 注入最终结论，failed 按节点写法处理。 */
	private async childOutcome(
		node: FlowNode,
		child: FlowRunRecord,
	): Promise<NodeOutcome> {
		if (child.status === "completed") {
			return {
				result: FLOW_REFERENCE_SUCCESS_RESULT,
				variables: await this.childResultVariables(node, child),
			};
		}
		if (node.successors.has(FLOW_REFERENCE_FAILURE_RESULT)) {
			return {
				result: FLOW_REFERENCE_FAILURE_RESULT,
				variables: {},
			};
		}
		throw new FlowRuntimeError(
			"flow_reference",
			`子 Flow 运行失败 (${child.id}): ${child.error?.summary ?? "未知错误"}`,
		);
	}

	private async childResultVariables(
		node: FlowNode,
		child: FlowRunRecord,
	): Promise<FlowVariables> {
		const names = Object.keys(
			declaredResultVariables(node, FLOW_REFERENCE_SUCCESS_RESULT),
		);
		const records = (await this.store.listNodeRuns(child.id))
			.filter((record) => record.status === "completed")
			.sort((left, right) => left.sequence - right.sequence);
		const variables = records.at(-1)?.outcome?.variables ?? {};
		return Object.fromEntries(
			names
				.filter((name) => Object.hasOwn(variables, name))
				.map((name) => [name, clone(variables[name])]),
		);
	}

	/** 父 NodeRun 中断后的引用节点恢复：先把子 Run 推到终态，再补全父节点结果并续接路由。 */
	private async resumeFlowReferenceNode(
		run: FlowRunRecord,
		current: NodeRunRecord,
		node: FlowNode,
		options: { existingAgentReference?: string; cwd?: string },
	): Promise<FlowRunRecord> {
		const child = (await this.store.listChildRuns(run.id)).find(
			(candidate) => candidate.parentNodeRunId === current.id,
		);
		let terminal: FlowRunRecord | undefined =
			child && (child.status === "completed" || child.status === "failed")
				? child
				: undefined;
		if (!terminal && child) {
			const pkg = this.references?.get(child.flowId);
			if (!pkg)
				throw new FlowRuntimeError(
					"flow_reference",
					`被引用的 Flow 未在闭包中加载: ${child.flowId}`,
				);
			if (!this.extensions.childFlow)
				throw new Error("Flow 缺少扩展能力: Child Flow Executor");
			terminal = await this.extensions.childFlow.resume({
				flow: pkg,
				references: this.references ?? new Map(),
				input: { variables: child.variables },
				runId: child.id,
				parentRunId: run.id,
				parentNodeRunId: current.id,
				cwd: options.cwd,
			});
		}
		if (!terminal) {
			// 没有子 Run：子 Flow 尚未启动，按中断重试整个节点。
			await this.interruptNode(run, current);
			await this.agentModel.start(
				run.id,
				options.existingAgentReference,
				options.cwd,
				run.agentAssembly,
				run.agentProfile,
				false,
			);
			return this.continueRun(
				run,
				current.nodeRef,
				current.input,
				options,
				{ kind: "recovery", nodeRunId: current.id },
				true,
				undefined,
				current,
			);
		}
		try {
			const outcome = await this.childOutcome(node, terminal);
			if (current.status !== "completed")
				await this.completeNode(run, current, outcome);
			await this.agentModel.start(
				run.id,
				options.existingAgentReference,
				options.cwd,
				run.agentAssembly,
				run.agentProfile,
				false,
			);
			await this.recordRecovery(
				run,
				current.id,
				"continue_routing",
				"从已终态的子 Flow 运行补全节点结果并续接路由",
			);
			return this.continueRun(
				run,
				current.nodeRef,
				current.input,
				options,
				current.enteredFrom,
				true,
				{ record: current, outcome },
			);
		} catch (error) {
			if (error instanceof AttemptUnconfirmed) throw error;
			if (current.status !== "failed")
				await this.failNode(run, current, toFlowError(error, "flow_reference"));
			throw error;
		}
	}

	/**
	 * 渲染确认提示、提交挂起事实并抛出 AwaitingInput 哨兵。
	 * 节点保持 running，Run 转为 awaiting_input 阶段；由宿主捕获哨兵后干净退出。
	 */
	private async suspendForConfirm(
		run: FlowRunRecord,
		record: NodeRunRecord,
		node: FlowNode,
		input: FlowValue | undefined,
	): Promise<never> {
		const action = node.action;
		if (action.kind !== "confirm")
			throw new FlowRuntimeError(
				"outcome_validation",
				`节点不是确认节点: ${node.ref}`,
			);
		const message = renderPrompt(action.prompt, run.variables ?? {}, isFlowValueRecord(input) ? input : {});
		record.pendingInput = { message, options: [...node.results.keys()] };
		await this.commit(
			run,
			(next) => {
				next.status = "running";
				next.phase = "awaiting_input";
				next.currentNodeRef = record.nodeRef;
				next.currentInput = record.input;
				next.currentNodeRunId = record.id;
				return { nodeRuns: [record] };
			},
			[
				{
					type: "run.awaiting_input",
					nodeRunId: record.id,
					nodeName: record.nodeName,
					nodeRef: record.nodeRef,
					summary: `节点“${displayNodeName(record)}”等待人工确认`,
				},
			],
		);
		throw new AwaitingInput(
			`节点“${displayNodeName(record)}”等待人工确认`,
		);
	}

	/** 人工应答入口：校验挂起事实与结果边，然后从已应答节点续接路由。 */
	async respond(
		runId: string,
		nodeRunId: string,
		result: string,
		options: { existingAgentReference?: string; cwd?: string } = {},
	): Promise<FlowRunRecord> {
		const run = await this.store.getRun(runId);
		if (!run) throw new Error(`Flow 运行不存在: ${runId}`);
		if (run.parentRunId)
			throw new Error(`子 Flow 运行不支持直接应答: ${runId}`);
		if (run.status !== "running" || run.phase !== "awaiting_input")
			throw new Error(`Flow 运行不在等待人工确认状态: ${runId}`);
		const nodeRuns = await this.store.listNodeRuns(runId);
		const pending = nodeRuns.find(
			(record) =>
				record.id === nodeRunId &&
				record.status === "running" &&
				record.pendingInput,
			);
		if (!pending || run.currentNodeRunId !== pending.id)
			throw new Error(`节点不在等待人工确认: ${nodeRunId}`);
		const node = this.flow.nodes.get(pending.nodeRef);
		if (!node || node.action.kind !== "confirm")
			throw new Error(`节点不是确认节点: ${pending.nodeRef}`);
		if (!node.results.has(result))
			throw new Error(
				`无效的确认结果 “${result}”，可选：${[...node.results.keys()].join("、")}`,
			);
		await this.completeNode(run, pending, { result });
		await this.recordRecovery(run, undefined, "continue_routing", "人工确认已应答，继续路由");
		await this.agentModel.start(
			run.id,
			options.existingAgentReference,
			options.cwd,
			run.agentAssembly,
			run.agentProfile,
			false,
		);
		return this.continueRun(
			run,
			pending.nodeRef,
			pending.input,
			options,
			pending.enteredFrom,
			true,
			{ record: pending, outcome: { result } },
		);
	}

	private async completeNode(
		run: FlowRunRecord,
		record: NodeRunRecord,
		outcome: NodeOutcome,
		round?: ParallelRoundRecord,
		branchRef?: string,
	): Promise<void> {
		const declared = declaredResultVariables(
			this.flow.nodes.get(record.nodeRef),
			outcome.result,
		);
		const globalDeclarations = this.flow.variables ?? {};
		validateOutcomeVariables(globalDeclarations, declared, outcome.variables);
		const globalVariables = pickDeclaredVariables(globalDeclarations, outcome.variables);
		const updatedVariables = {
			...clone(run.variables ?? {}),
			...globalVariables,
		};
		record.status = "completed";
		record.outcome = outcome;
		record.completedAt = now();
		await this.commit(
			run,
			(next) => {
				if (next.status === "interrupted") {
					next.status = "running";
					next.phase = "executing_node";
					delete next.error;
				}
				if (branchRef && round) {
					round.variablePatches ??= {};
					round.variablePatches[branchRef] = clone(outcome.variables ?? {});
				} else {
					next.variables = updatedVariables;
				}
				const updatedRound = round ? clone(round) : undefined;
				if (updatedRound && !branchRef) {
					updatedRound.status = "completed";
					updatedRound.joinOutcome = outcome;
					updatedRound.completedAt = record.completedAt;
					delete next.currentParallelRoundId;
				}
				return {
					nodeRuns: [record],
					parallelRounds: updatedRound ? [updatedRound] : undefined,
				};
			},
			[
				{
					type: "node.completed",
					nodeRunId: record.id,
					nodeName: record.nodeName,
					nodeRef: record.nodeRef,
					nodeStatus: "completed",
					summary: `节点“${displayNodeName(record)}”已完成，结果为“${outcome.result}”`,
				},
			],
		);
	}

	private async selectRoute(
		run: FlowRunRecord,
		record: NodeRunRecord,
		result: string,
		destination: FlowDestination,
		parallelRoundId?: string,
		affectRun = true,
	): Promise<RouteDecisionRecord> {
		const decision: RouteDecisionRecord = {
			id: randomUUID(),
			runId: run.id,
			sequence: 0,
			sourceNodeRunId: record.id,
			result,
			destination,
			parallelRoundId,
			selectedAt: now(),
		};
		await this.commit(
			run,
			(next, sequence) => {
				decision.sequence = sequence;
				if (affectRun) next.phase = "routing";
				return { routeDecisions: [decision] };
			},
			[
				{
					type: "route.selected",
					nodeRunId: record.id,
					nodeName: record.nodeName,
					nodeRef: record.nodeRef,
					result,
					destination,
					summary: `节点“${displayNodeName(record)}”选择结果“${result}”的去向`,
				},
			],
		);
		return decision;
	}

	private async enterParallel(
		run: FlowRunRecord,
		parallelRef: string,
		input: FlowValue,
		sourceNodeRunId: string,
		roundId: string,
	): Promise<void> {
		if (!this.flow.parallels.has(parallelRef)) {
			const error = new FlowRuntimeError(
				"parallel_configuration",
				`并行开始点不存在: ${parallelRef}`,
			);
			await this.failRun(run, toFlowError(error, "parallel_configuration"));
			throw error;
		}
		const round: ParallelRoundRecord = {
			id: roundId,
			runId: run.id,
			sequence: 0,
			parallelRef,
			input,
			status: "running",
			startedAt: now(),
			branchNodeRunIds: {},
			branchStatuses: {},
			variablePatches: {},
			sourceNodeRunId,
		};
		await this.commit(
			run,
			(next, sequence) => {
				round.sequence = sequence;
				next.phase = "waiting_parallel";
				delete next.currentNodeRef;
				delete next.currentNodeRunId;
				next.currentInput = input;
				next.currentParallelRoundId = round.id;
				return { parallelRounds: [round] };
			},
			[
				{
					type: "parallel.started",
					parallelRoundId: round.id,
					parallelStatus: "running",
					summary: `并行轮次“${parallelRef}”已开始`,
				},
			],
		);
	}

	private async completeRun(run: FlowRunRecord): Promise<void> {
		await this.commit(
			run,
			(next) => {
				next.status = "completed";
				next.phase = "completed";
				next.completedAt = now();
				delete next.currentNodeRef;
				delete next.currentNodeRunId;
				delete next.currentParallelRoundId;
				delete next.currentInput;
				return {};
			},
			[
				{
					type: "run.completed",
					summary: "Flow 运行已完成",
				},
			],
		);
	}

	private async interruptNode(
		run: FlowRunRecord,
		record: NodeRunRecord,
		round?: ParallelRoundRecord,
		branchRef?: string,
	): Promise<void> {
		record.status = "interrupted";
		record.completedAt = now();
		record.error = {
			category: "recovery",
			summary: "运行进程在节点完成前中断",
		};
		await this.commit(
			run,
			(next) => {
				next.status = "interrupted";
				next.phase = "interrupted";
				if (round) {
					round.status = "interrupted";
					round.error = record.error;
					if (branchRef) round.branchStatuses[branchRef] = "interrupted";
				}
				return {
					nodeRuns: [record],
					parallelRounds: round ? [round] : undefined,
				};
			},
			[
				{
					type: "node.interrupted",
					nodeRunId: record.id,
					nodeName: record.nodeName,
					nodeRef: record.nodeRef,
					nodeStatus: "interrupted",
					summary: `节点“${displayNodeName(record)}”已中断`,
				},
				{
					type: "run.interrupted",
					nodeRunId: record.id,
					nodeName: record.nodeName,
					nodeRef: record.nodeRef,
					summary: `节点“${displayNodeName(record)}”执行中断，Flow 运行已中断`,
				},
			],
		);
		await this.interruptActiveChildRuns(run.id, record.id);
	}

	/** 父节点被中断时，同节点仍活跃的子 Run 同步标记为 interrupted。 */
	private async interruptActiveChildRuns(
		runId: string,
		nodeRunId: string,
	): Promise<void> {
		const children = (await this.store.listChildRuns(runId)).filter(
			(child) =>
				child.status === "running" && child.parentNodeRunId === nodeRunId,
		);
		for (const child of children) {
			const running = (await this.store.listNodeRuns(child.id)).filter(
				(record) => record.status === "running",
			);
			for (const nodeRun of running) {
				nodeRun.status = "interrupted";
				nodeRun.completedAt = now();
				nodeRun.error = {
					category: "recovery",
					summary: "父节点中断，子 Flow 运行同步中断",
				};
			}
			const next = clone(child);
			next.status = "interrupted";
			next.phase = "interrupted";
			next.completedAt = now();
			next.sequence = child.sequence + 1;
			await this.store.commit({
				run: next,
				expectedSequence: child.sequence,
				nodeRuns: running,
			});
			this.publishObservation(next, {
				type: "run.interrupted",
				nodeRunId: undefined,
				summary: `父节点中断，子 Flow 运行 ${child.id} 已同步中断`,
			});
		}
	}

	private async failInterruptedCommand(
		run: FlowRunRecord,
		record: NodeRunRecord,
		round?: ParallelRoundRecord,
	): Promise<never> {
		const error: FlowError = {
			category: "command_interrupted",
			summary: `自定义命令节点“${displayNodeName(record)}”在完成前中断，无法安全自动重试`,
		};
		const recovery: RunRecoveryRecord = {
			id: randomUUID(),
			runId: run.id,
			sequence: 0,
			interruptedNodeRunId: record.id,
			strategy: "fail_command",
			resumedAt: now(),
			summary: error.summary,
		};
		await this.commit(
			run,
			(next, sequence) => {
				recovery.sequence = sequence;
				next.status = "failed";
				next.phase = "failed";
				next.error = error;
				next.completedAt = now();
				if (round) {
					round.status = "failed";
					round.error = error;
				}
				return {
					parallelRounds: round ? [round] : undefined,
					recoveries: [recovery],
				};
			},
			[
				{
					type: "run.failed",
					nodeRunId: record.id,
					nodeName: record.nodeName,
					nodeRef: record.nodeRef,
					summary: error.summary,
				},
			],
		);
		throw new FlowRuntimeError(error.category, error.summary);
	}

	private async failNode(
		run: FlowRunRecord,
		record: NodeRunRecord,
		error: FlowError,
		round?: ParallelRoundRecord,
		branchRef?: string,
	): Promise<void> {
		record.status = "failed";
		record.error = error;
		record.completedAt ??= now();
		await this.commit(run, (next) => {
			next.status = "failed";
			next.phase = "failed";
			next.error = error;
			next.completedAt = now();
			if (round) {
				round.status = "failed";
				round.error = error;
				if (branchRef) round.branchStatuses[branchRef] = "failed";
			}
			return {
				nodeRuns: [record],
				parallelRounds: round ? [round] : undefined,
			};
		});
	}

	private async failRun(run: FlowRunRecord, error: FlowError): Promise<void> {
		await this.commit(run, (next) => {
			next.status = "failed";
			next.phase = "failed";
			next.error = error;
			next.completedAt = now();
			return {};
		});
	}

	private async recordRecovery(
		run: FlowRunRecord,
		interruptedNodeRunId: string | undefined,
		strategy: RunRecoveryRecord["strategy"],
		summary: string,
	): Promise<void> {
		const recovery: RunRecoveryRecord = {
			id: randomUUID(),
			runId: run.id,
			sequence: 0,
			interruptedNodeRunId,
			strategy,
			resumedAt: now(),
			summary,
		};
		await this.commit(run, (next, sequence) => {
			recovery.sequence = sequence;
			next.status = "running";
			next.phase = "routing";
			delete next.error;
			return { recoveries: [recovery] };
		});
	}

	private async requireParallelRound(
		run: FlowRunRecord,
		roundId: string,
	): Promise<ParallelRoundRecord> {
		const round = (await this.store.listParallelRounds(run.id)).find(
			(record) => record.id === roundId,
		);
		if (!round) {
			const error = new FlowRuntimeError(
				"parallel_configuration",
				`并行轮次不存在: ${roundId}`,
			);
			await this.failRun(run, toFlowError(error, "parallel_configuration"));
			throw error;
		}
		return round;
	}

	private destination(nodeRef: string, resultName: string): FlowDestination {
		const node = this.flow.nodes.get(nodeRef);
		return requireOutcomeRoute(nodeRef, resultName, node?.successors.get(resultName));
	}

	private publishObservationChanges(
		previous: FlowRunRecord,
		next: FlowRunRecord,
		changes: FactChanges,
		observationSpecs: ObservationSpec[] = [],
	): void {
		const specs: ObservationSpec[] = [...observationSpecs];
		if (specs.length === 0) {
			for (const record of changes.nodeRuns ?? []) {
				// Binding metadata updates persist a running record without starting it again.
				if (record.status === "running" && record.sequence !== next.sequence)
					continue;
				const type =
					record.status === "running"
						? "node.started"
						: record.status === "completed"
							? "node.completed"
							: record.status === "failed"
								? "node.failed"
								: "node.interrupted";
				specs.push({
					type,
					nodeRunId: record.id,
					nodeName: record.nodeName,
					nodeRef: record.nodeRef,
					nodeStatus: record.status,
					summary:
						type === "node.started"
							? `节点“${displayNodeName(record)}”开始执行`
							: `节点“${displayNodeName(record)}”状态为 ${record.status}`,
				});
			}
			for (const decision of changes.routeDecisions ?? []) {
				specs.push({
					type: "route.selected",
					nodeRunId: decision.sourceNodeRunId,
					result: decision.result,
					destination: decision.destination,
					summary: `节点选择结果“${decision.result}”的去向`,
				});
			}
			for (const round of changes.parallelRounds ?? []) {
				if (round.sequence === next.sequence) {
					specs.push({
						type: "parallel.started",
						parallelRoundId: round.id,
						parallelStatus: round.status,
						summary: `并行轮次“${round.parallelRef}”已开始`,
					});
				} else if (round.status === "completed") {
					specs.push({
						type: "parallel.completed",
						parallelRoundId: round.id,
						parallelStatus: round.status,
						summary: `并行轮次“${round.parallelRef}”已完成并准备汇合`,
					});
				}
			}
			for (const recovery of changes.recoveries ?? []) {
				if (recovery.strategy !== "fail_command") {
					specs.push({ type: "run.resumed", summary: recovery.summary });
				}
			}
			if (previous.status !== next.status) {
				if (next.status === "completed")
					specs.push({ type: "run.completed", summary: "Flow 运行已完成" });
				if (next.status === "failed") {
					const failedNode = [...(changes.nodeRuns ?? [])]
						.reverse()
						.find((record) => record.status === "failed");
					specs.push({
						type: "run.failed",
						nodeRunId: failedNode?.id,
						nodeName: failedNode?.nodeName,
						nodeRef: failedNode?.nodeRef,
						summary: failedNode
							? `节点“${displayNodeName(failedNode)}”执行失败：${next.error?.summary ?? "未知错误"}`
							: (next.error?.summary ?? "Flow 运行失败"),
					});
				}
				if (next.status === "interrupted")
					specs.push({ type: "run.interrupted", summary: "Flow 运行已中断" });
			}
		}
		for (const spec of specs) this.publishObservation(next, spec);
	}

	private publishObservation(run: FlowRunRecord, spec: ObservationSpec): void {
		if (!this.publisher) return;
		const event: FlowObservationEvent = {
			type: spec.type,
			runId: run.id,
			flowId: run.flowId,
			sequence: run.sequence,
			occurredAt: now(),
			status: run.status,
			phase: run.phase,
			nodeRunId: spec.nodeRunId,
			nodeName: spec.nodeName,
			nodeRef: spec.nodeRef,
			parallelRoundId: spec.parallelRoundId,
			result: spec.result,
			destination: spec.destination,
			nodeStatus: spec.nodeStatus,
			parallelStatus: spec.parallelStatus,
			summary: spec.summary,
		};
		try {
			this.publisher.publish(event);
		} catch (error) {
			try {
				this.onObservationError(error, event);
			} catch {
				// Diagnostics must never affect a persisted Run.
			}
		}
	}

	private async commit(
		run: FlowRunRecord,
		prepare: (next: FlowRunRecord, sequence: number) => FactChanges,
		observationSpecs: ObservationSpec[] = [],
	): Promise<void> {
		const write = this.writes.then(async () => {
			const expectedSequence = run.sequence;
			const next = clone(run);
			const sequence = expectedSequence + 1;
			const changes = prepare(next, sequence);
			next.sequence = sequence;
			await this.store.commit({
				run: next,
				expectedSequence,
				...changes,
			});
			const previous = clone(run);
			replaceObject(run, next);
			this.publishObservationChanges(previous, next, changes, observationSpecs);
		});
		this.writes = write.then(
			() => undefined,
			() => undefined,
		);
		return write;
	}
}

class FlowRuntimeError extends Error {
	readonly category: FlowErrorCategory;

	constructor(category: FlowErrorCategory, message: string) {
		super(message);
		this.category = category;
	}
}

function now(): string {
	return new Date().toISOString();
}

function declaredResultVariables(
	node: FlowNode | undefined,
	result: string,
): Record<string, { description: string }> {
	return node?.resultVariables?.get(result) ?? {};
}

function extractNextInput(
	node: FlowNode | undefined,
	outcome: NodeOutcome,
): FlowVariables {
	return pickDeclaredVariables(declaredResultVariables(node, outcome.result), outcome.variables ?? {});
}

function toFlowError(error: unknown, fallback: FlowErrorCategory): FlowError {
	if (error instanceof FlowRuntimeError)
		return { category: error.category, summary: error.message };
	if (error instanceof RouteNotFoundError)
		return { category: "route_not_found", summary: error.message };
	if (error instanceof VariableReferenceError)
		return { category: "variable_reference", summary: error.message };
	const summary = error instanceof Error ? error.message : String(error);
	if (
		/Agent Profile|Profile 装配|无法隔离|能力不匹配/.test(
			summary,
		)
	)
		return { category: "agent_capability", summary };
	if (
		/节点不允许结果|必须通过结果提交工具|只能提交一次结果|引用不匹配/.test(
			summary,
		)
	) {
		return { category: "outcome_validation", summary };
	}
	return { category: fallback, summary };
}

export function fingerprintFlow(
	flow: FlowDefinition,
	references?: ReadonlyMap<string, FlowPackage>,
): string {
	const childIds = new Set<string>();
	for (const node of flow.nodes.values()) {
		if (node.action.kind === "执行Flow") childIds.add(node.action.flow);
	}
	const children = [...childIds].sort().map((id) => {
		const pkg = references?.get(id);
		if (!pkg)
			throw new FlowRuntimeError(
				"flow_reference",
				`被引用的 Flow 未在闭包中加载: ${id}`,
			);
		return fingerprintFlow(pkg.flow, references);
	});
	const definition = {
		id: flow.id,
		name: flow.name,
		description: flow.description,
		startNodeRef: flow.startNodeRef,
		nodes: [...flow.nodes.values()].map((node) => ({
			ref: node.ref,
			name: node.name,
			action: node.action,
			results: [...node.results.entries()],
			resultVariables: [...(node.resultVariables?.entries() ?? [])],
			successors: [...node.successors.entries()],
		})),
		parallels: [...flow.parallels.values()],
		variables: flow.variables,
	};
	return `sha256:${createHash("sha256").update(JSON.stringify({ definition, children })).digest("hex")}`;
}

function displayNodeName(
	record: Pick<NodeRunRecord, "nodeName" | "nodeRef">,
): string {
	return record.nodeName ?? record.nodeRef;
}

function renderAgentProfile(
	profile: AgentProfileReference | undefined,
	input: FlowValue | undefined,
	variables: FlowVariables,
): AgentProfileReference | undefined {
	if (!profile) return undefined;
	return {
		id: profile.id,
		...(profile.params
			? {
					params: renderTemplate(profile.params, {
						input: isFlowValueRecord(input) ? input : {},
						variables,
					}) as FlowVariables,
				}
			: {}),
	};
}

function renderAgentPrompt(
	prompt: string,
	input: FlowValue | undefined,
	node: FlowNode,
	resources?: FlowResourceContext,
	variables: FlowVariables = {},
): string {
	const outcomes = [...node.results]
		.map(([name, description]) => {
			const variables = Object.keys(node.resultVariables?.get(name) ?? {});
			const variableHint = variables.length
				? `；variables 顶层允许：${variables.join(", ")}，复杂结果放在对应对象中`
				: "";
			return `- ${name}: ${description}${variableHint}`;
		})
		.join("\n");
	const rendered = resolvePromptResources(prompt, resources);
	return `${renderPrompt(rendered, variables, isFlowValueRecord(input) ? input : {})}\n\n本节点只允许提交以下一个结果：\n${outcomes}\n\n完成工作后必须调用 submit_flow_outcome，并提供 outcome，可选提供 variables。`;
}

function parseCommandVariables(
	stdout: string,
): { variables: FlowVariables } | undefined {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new FlowRuntimeError(
				"variable_type",
				"命令 output:variables 必须是 JSON 对象",
			);
		const record = parsed as Record<string, unknown>;
		if (record.variables === undefined || !isFlowValueRecord(record.variables))
			throw new FlowRuntimeError(
				"variable_type",
				"命令 variables 必须是 JSON 对象",
			);
		if (Object.keys(record).some((key) => key !== "variables"))
			throw new FlowRuntimeError(
				"variable_type",
				"命令 output:variables 只能包含 variables 字段",
			);
		validateVariables(record.variables);
		return { variables: record.variables };
	} catch (error) {
		if (error instanceof FlowRuntimeError) throw error;
		throw new FlowRuntimeError(
			"variable_type",
			"命令 output:variables 不是有效 JSON 信封",
		);
	}
}

function isFlowValue(value: unknown): value is FlowValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	)
		return true;
	if (Array.isArray(value)) return value.every(isFlowValue);
	return isFlowValueRecord(value);
}

function isFlowValueRecord(value: unknown): value is FlowVariables {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every(isFlowValue)
	);
}

function mergeParallelVariables(
	base: FlowVariables,
	patches: Record<string, FlowVariables>,
): FlowVariables {
	const merged = clone(base);
	const owners = new Map<string, string>();
	for (const branch of Object.keys(patches).sort()) {
		for (const [name, value] of Object.entries(patches[branch] ?? {})) {
			const previous = owners.get(name);
			if (previous)
				throw new FlowRuntimeError(
					"variable_conflict",
					`并行分支“${previous}”与“${branch}”同时写入变量: ${name}`,
				);
			owners.set(name, branch);
			merged[name] = clone(value);
		}
	}
	return merged;
}

function replaceObject<T extends object>(target: T, source: T): void {
	for (const key of Object.keys(target)) {
		if (!(key in source)) delete (target as Record<string, unknown>)[key];
	}
	Object.assign(target, source);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
