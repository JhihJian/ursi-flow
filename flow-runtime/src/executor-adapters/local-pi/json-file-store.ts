import { randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lock } from "proper-lockfile";
import type {
	FlowRunRecord,
	FlowRunSnapshot,
	NodeRunRecord,
	ParallelRoundRecord,
	RouteDecisionRecord,
	RunFactCommit,
	RunRecoveryRecord,
} from "ursi-flow-core/engine";
import {
	InMemoryRunStore,
	normalizeParallelRound,
} from "ursi-flow-core/engine";

interface PersistedRuns {
	runs: FlowRunRecord[];
	nodeRuns: NodeRunRecord[];
	routeDecisions?: RouteDecisionRecord[];
	parallelRounds?: ParallelRoundRecord[];
	recoveries?: RunRecoveryRecord[];
}

export class JsonFileRunStore extends InMemoryRunStore {
	private operations = Promise.resolve();
	private readonly file: string;

	constructor(file: string) {
		super();
		this.file = file;
	}

	private async loadPersisted(): Promise<void> {
		this.runs.clear();
		this.nodeRuns.clear();
		this.routeDecisions.clear();
		this.parallelRounds.clear();
		this.recoveries.clear();
		try {
			const saved = JSON.parse(
				await readFile(this.file, "utf8"),
			) as PersistedRuns;
			for (const run of saved.runs ?? []) await super.createRun(run);
			for (const nodeRun of saved.nodeRuns ?? [])
				await super.createNodeRun(nodeRun);
			for (const decision of saved.routeDecisions ?? [])
				this.routeDecisions.set(decision.id, clone(decision));
			for (const round of saved.parallelRounds ?? [])
				this.parallelRounds.set(
					round.id,
					clone(normalizeParallelRound(round, round.runId)),
				);
			for (const recovery of saved.recoveries ?? [])
				this.recoveries.set(recovery.id, clone(recovery));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	protected async persist(): Promise<void> {
		const saved: PersistedRuns = {
			runs: [...this.runs.values()].map(clone),
			nodeRuns: [...this.nodeRuns.values()].map(clone),
			routeDecisions: [...this.routeDecisions.values()].map(clone),
			parallelRounds: [...this.parallelRounds.values()].map(clone),
			recoveries: [...this.recoveries.values()].map(clone),
		};
		await mkdir(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
			await rename(temporary, this.file);
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	private async mutate<T>(operation: () => Promise<T>): Promise<T> {
		return this.enqueue(() =>
			this.withFileLock(async () => {
				await this.reload();
				const maps = [
					this.runs,
					this.nodeRuns,
					this.routeDecisions,
					this.parallelRounds,
					this.recoveries,
				] as Map<string, unknown>[];
				const snapshots = maps.map((map) => new Map(map));
				try {
					const result = await operation();
					await this.persist();
					return result;
				} catch (error) {
					maps.forEach((map, index) => {
						map.clear();
						for (const [key, value] of snapshots[index]) map.set(key, value);
					});
					throw error;
				}
			}),
		);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.operations.then(operation);
		this.operations = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	private read<T>(operation: () => T): Promise<T> {
		return this.enqueue(async () => {
			await this.reload();
			return operation();
		});
	}

	private async reload(): Promise<void> {
		await this.loadPersisted();
	}

	private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.file), { recursive: true });
		const file = join(await realpath(dirname(this.file)), basename(this.file));
		const release = await lock(file, {
			realpath: false,
			stale: 10_000,
			update: 2_000,
			retries: { retries: 120, minTimeout: 100, maxTimeout: 100, factor: 1 },
		});
		try {
			return await operation();
		} finally {
			await release();
		}
	}

	override async createRun(run: FlowRunRecord): Promise<void> {
		await this.mutate(() => super.createRun(run));
	}

	override async commit(fact: RunFactCommit): Promise<void> {
		await this.mutate(() => super.commit(fact));
	}

	override async updateRun(run: FlowRunRecord): Promise<void> {
		await this.mutate(() => super.updateRun(run));
	}

	override async getRun(runId: string): Promise<FlowRunRecord | undefined> {
		return this.read(() => super.getRun(runId));
	}

	override async getRunSnapshot(
		runId: string,
	): Promise<FlowRunSnapshot | undefined> {
		return this.read(() => super.getRunSnapshot(runId));
	}

	override async listRuns(flowId: string): Promise<FlowRunRecord[]> {
		return this.read(() => super.listRuns(flowId));
	}

	override async listAllRuns(): Promise<FlowRunRecord[]> {
		return this.read(() => super.listAllRuns());
	}

	override async listRunningRuns(): Promise<FlowRunRecord[]> {
		return this.read(() => super.listRunningRuns());
	}

	override async createNodeRun(record: NodeRunRecord): Promise<void> {
		await this.mutate(() => super.createNodeRun(record));
	}

	override async updateNodeRun(record: NodeRunRecord): Promise<void> {
		await this.mutate(() => super.updateNodeRun(record));
	}

	override async listNodeRuns(runId: string): Promise<NodeRunRecord[]> {
		return this.read(() => super.listNodeRuns(runId));
	}

	override async listRouteDecisions(
		runId: string,
	): Promise<RouteDecisionRecord[]> {
		return this.read(() => super.listRouteDecisions(runId));
	}

	override async listParallelRounds(
		runId: string,
	): Promise<ParallelRoundRecord[]> {
		return this.read(() => super.listParallelRounds(runId));
	}

	override async listRunRecoveries(
		runId: string,
	): Promise<RunRecoveryRecord[]> {
		return this.read(() => super.listRunRecoveries(runId));
	}

	override async listChildRuns(parentRunId: string): Promise<FlowRunRecord[]> {
		return this.read(() => super.listChildRuns(parentRunId));
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
