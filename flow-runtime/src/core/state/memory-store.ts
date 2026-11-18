import type {
	FlowError,
	FlowRunRecord,
	FlowRunSnapshot,
	NodeRunRecord,
	ParallelRoundRecord,
	RouteDecisionRecord,
	RunFactCommit,
	RunRecoveryRecord,
	RunStore,
} from "../contracts/types.ts";
export class InMemoryRunStore implements RunStore {
	protected readonly runs = new Map<string, FlowRunRecord>();
	protected readonly nodeRuns = new Map<string, NodeRunRecord>();
	protected readonly routeDecisions = new Map<string, RouteDecisionRecord>();
	protected readonly parallelRounds = new Map<string, ParallelRoundRecord>();
	protected readonly recoveries = new Map<string, RunRecoveryRecord>();

	async createRun(run: FlowRunRecord): Promise<void> {
		if (this.runs.has(run.id)) throw new Error(`Flow 运行已存在: ${run.id}`);
		const normalized = normalizeRun(run);
		this.runs.set(normalized.id, clone(normalized));
		if (normalized.currentParallelRound) {
			const round = normalizeParallelRound(
				normalized.currentParallelRound,
				normalized.id,
			);
			this.parallelRounds.set(round.id, clone(round));
			normalized.currentParallelRoundId = round.id;
			delete normalized.currentParallelRound;
			this.runs.set(normalized.id, clone(normalized));
		}
	}

	async commit(fact: RunFactCommit): Promise<void> {
		// Clone every record before touching visible maps, including caller-owned values.
		fact = clone(fact);
		const stored = this.runs.get(fact.run.id);
		if (!stored) throw new Error(`Flow 运行不存在: ${fact.run.id}`);
		if (stored.sequence !== fact.expectedSequence) {
			throw new Error(
				`Flow 运行版本冲突: ${fact.run.id}，期望 ${fact.expectedSequence}，实际 ${stored.sequence}`,
			);
		}
		if (fact.run.sequence !== fact.expectedSequence + 1) {
			throw new Error(`Flow 运行提交序号无效: ${fact.run.id}`);
		}
		for (const field of [
			"flowId",
			"flowVersion",
			"startedAt",
			"parentRunId",
			"parentNodeRunId",
		] as const) {
			if (stored[field] !== fact.run[field])
				throw new Error(`Flow 运行不可修改身份字段: ${field}`);
		}
		if (
			(stored.status === "completed" || stored.status === "failed") &&
			fact.run.status !== stored.status
		)
			throw new Error(
				`Flow 终态不可迁移: ${stored.status} -> ${fact.run.status}`,
			);
		if (fact.run.status !== "running" && fact.run.phase !== fact.run.status)
			throw new Error("Flow 状态与阶段不一致");
		this.validateFactRecords(fact);
		this.runs.set(fact.run.id, clone(normalizeRun(fact.run)));
		for (const record of fact.nodeRuns ?? []) {
			this.nodeRuns.set(record.id, clone(normalizeNodeRun(record)));
		}
		for (const decision of fact.routeDecisions ?? []) {
			this.routeDecisions.set(decision.id, clone(decision));
		}
		for (const round of fact.parallelRounds ?? []) {
			this.parallelRounds.set(
				round.id,
				clone(normalizeParallelRound(round, fact.run.id)),
			);
		}
		for (const recovery of fact.recoveries ?? []) {
			this.recoveries.set(recovery.id, clone(recovery));
		}
	}

	private validateFactRecords(fact: RunFactCommit): void {
		for (const [records, stored] of [
			[fact.nodeRuns ?? [], this.nodeRuns],
			[fact.routeDecisions ?? [], this.routeDecisions],
			[fact.parallelRounds ?? [], this.parallelRounds],
			[fact.recoveries ?? [], this.recoveries],
		] as const) {
			const ids = new Set<string>();
			for (const record of records) {
				if (ids.has(record.id)) throw new Error(`重复事实标识: ${record.id}`);
				ids.add(record.id);
				const previous = stored.get(record.id);
				if (previous && previous.runId !== record.runId)
					throw new Error(`事实标识已属于其他运行: ${record.id}`);
				if (
					!Number.isSafeInteger(record.sequence) ||
					record.sequence < 0 ||
					record.sequence > fact.run.sequence
				)
					throw new Error(`事实提交序号无效: ${record.id}`);
			}
		}
		for (const record of fact.nodeRuns ?? []) {
			if (record.runId !== fact.run.id)
				throw new Error(`NodeRun 不属于当前 Flow 运行: ${record.id}`);
		}
		for (const decision of fact.routeDecisions ?? []) {
			if (decision.runId !== fact.run.id)
				throw new Error(`路由记录不属于当前 Flow 运行: ${decision.id}`);
		}
		for (const round of fact.parallelRounds ?? []) {
			if (round.runId !== fact.run.id)
				throw new Error(`并行轮次不属于当前 Flow 运行: ${round.id}`);
		}
		for (const recovery of fact.recoveries ?? []) {
			if (recovery.runId !== fact.run.id)
				throw new Error(`恢复记录不属于当前 Flow 运行: ${recovery.id}`);
		}
	}

	async updateRun(run: FlowRunRecord): Promise<void> {
		if (!this.runs.has(run.id)) throw new Error(`Flow 运行不存在: ${run.id}`);
		this.runs.set(run.id, clone(normalizeRun(run)));
	}

	async getRun(runId: string): Promise<FlowRunRecord | undefined> {
		const run = this.runs.get(runId);
		return run && clone(run);
	}

	async getRunSnapshot(runId: string): Promise<FlowRunSnapshot | undefined> {
		const run = this.runs.get(runId);
		if (!run) return undefined;
		return {
			run: clone(run),
			nodeRuns: this.recordsFor(this.nodeRuns, runId),
			routeDecisions: this.recordsFor(this.routeDecisions, runId),
			parallelRounds: this.recordsFor(this.parallelRounds, runId),
			recoveries: this.recordsFor(this.recoveries, runId),
		};
	}

	private recordsFor<T extends { runId: string; sequence: number }>(
		records: ReadonlyMap<string, T>,
		runId: string,
	): T[] {
		return [...records.values()]
			.filter((record) => record.runId === runId)
			.sort((left, right) => left.sequence - right.sequence)
			.map(clone);
	}

	async listRuns(flowId: string): Promise<FlowRunRecord[]> {
		return [...this.runs.values()]
			.filter((run) => run.flowId === flowId)
			.map(clone);
	}

	async listAllRuns(): Promise<FlowRunRecord[]> {
		return [...this.runs.values()].map(clone);
	}

	async listRunningRuns(): Promise<FlowRunRecord[]> {
		return [...this.runs.values()]
			.filter((run) => run.status === "running")
			.map(clone);
	}

	async createNodeRun(record: NodeRunRecord): Promise<void> {
		if (this.nodeRuns.has(record.id))
			throw new Error(`节点运行已存在: ${record.id}`);
		this.nodeRuns.set(record.id, clone(normalizeNodeRun(record)));
	}

	async updateNodeRun(record: NodeRunRecord): Promise<void> {
		if (!this.nodeRuns.has(record.id))
			throw new Error(`节点运行不存在: ${record.id}`);
		this.nodeRuns.set(record.id, clone(normalizeNodeRun(record)));
	}

	async listNodeRuns(runId: string): Promise<NodeRunRecord[]> {
		return [...this.nodeRuns.values()]
			.filter((record) => record.runId === runId)
			.sort((left, right) => left.sequence - right.sequence)
			.map(clone);
	}

	async listRouteDecisions(runId: string): Promise<RouteDecisionRecord[]> {
		return [...this.routeDecisions.values()]
			.filter((record) => record.runId === runId)
			.sort((left, right) => left.sequence - right.sequence)
			.map(clone);
	}

	async listParallelRounds(runId: string): Promise<ParallelRoundRecord[]> {
		return [...this.parallelRounds.values()]
			.filter((record) => record.runId === runId)
			.sort((left, right) => left.sequence - right.sequence)
			.map(clone);
	}

	async listRunRecoveries(runId: string): Promise<RunRecoveryRecord[]> {
		return [...this.recoveries.values()]
			.filter((record) => record.runId === runId)
			.sort((left, right) => left.sequence - right.sequence)
			.map(clone);
	}

	async listChildRuns(parentRunId: string): Promise<FlowRunRecord[]> {
		return [...this.runs.values()]
			.filter((run) => run.parentRunId === parentRunId)
			.sort((left, right) => left.startedAt.localeCompare(right.startedAt))
			.map(clone);
	}
}
function normalizeRun(run: FlowRunRecord): FlowRunRecord {
	const legacy = run as Partial<FlowRunRecord> & { error?: FlowError | string };
	const status = legacy.status ?? "running";
	const phase =
		legacy.phase ??
		(status === "completed" || status === "failed" || status === "interrupted"
			? status
			: legacy.currentParallelRound || legacy.currentParallelRoundId
				? "waiting_parallel"
				: legacy.currentNodeRef
					? "executing_node"
					: "starting");
	return {
		...run,
		variables: clone(legacy.variables ?? {}),
		flowVersion: legacy.flowVersion ?? "legacy:unknown",
		status,
		phase,
		sequence: legacy.sequence ?? 1,
		historyCompleteness:
			legacy.historyCompleteness ??
			(legacy.flowVersion ? "complete" : "legacy"),
		error:
			typeof legacy.error === "string"
				? { category: "legacy", summary: legacy.error }
				: legacy.error,
	} as FlowRunRecord;
}
function normalizeNodeRun(record: NodeRunRecord): NodeRunRecord {
	const legacy = record as Partial<NodeRunRecord>;
	return {
		...record,
		sequence: legacy.sequence ?? 0,
		actionKind: legacy.actionKind ?? "执行自定义命令",
		status:
			legacy.status ??
			(legacy.completedAt || legacy.outcome ? "completed" : "running"),
		enteredFrom: legacy.enteredFrom ?? { kind: "start" },
	} as NodeRunRecord;
}
export function normalizeParallelRound(
	round: ParallelRoundRecord,
	runId: string,
): ParallelRoundRecord {
	const legacy = round as Partial<ParallelRoundRecord>;
	const branchStatuses = { ...(legacy.branchStatuses ?? {}) };
	for (const branchRef of Object.keys(legacy.branchNodeRunIds ?? {})) {
		branchStatuses[branchRef] ??= "running";
	}
	return {
		...round,
		runId: legacy.runId ?? runId,
		sequence: legacy.sequence ?? 0,
		status: legacy.status ?? "running",
		startedAt: legacy.startedAt ?? new Date().toISOString(),
		branchNodeRunIds: { ...(legacy.branchNodeRunIds ?? {}) },
		branchStatuses,
		variablePatches: { ...(legacy.variablePatches ?? {}) },
	} as ParallelRoundRecord;
}
function clone<T>(value: T): T {
	return structuredClone(value);
}
