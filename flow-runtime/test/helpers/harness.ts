import { AgentRunModel } from "../../src/ability/agent-harness/executor.ts";
import type {
	AgentHarnessExtensions,
	AgentOpenRequest,
} from "ursi-flow-core/engine";
import type {
	AgentAssemblyRequest,
	AgentHandle,
	AgentTurnState,
	FlowAgentHarness,
	NodeOutcome,
	RuntimeToolBridge,
} from "ursi-flow-core/engine";
import type { FlowCoordinator } from "ursi-flow-core/engine";
import {
	createFlowCoordinator,
	type FlowHostOptions,
} from "../../src/executor-adapters/local-pi/runtime.ts";

export type TestOpenRequest = AgentOpenRequest & {
	assembly?: AgentAssemblyRequest;
};
export type TestRestoreRequest = TestOpenRequest & { sessionReference: string };
export type TestTurnRequest = Parameters<FlowAgentHarness["run"]>[1];

/** Fake host implements native bridge binding, with optional extensions explicit. */
export class TestHarness implements FlowAgentHarness {
	private readonly bridges = new Map<string, RuntimeToolBridge>();
	readonly extensions: AgentHarnessExtensions = {
		assembly: {
			preflightDeferred: () => undefined,
			preflight: () => undefined,
			open: (request) => this.open(request),
		},
		continuity: {
			rebind: async (agent, bridge) => {
				this.bridges.set(agent.id, bridge);
			},
			restore: async (request) => {
				const agent = await this.restore(request);
				this.bridges.set(agent.id, request.runtimeTools);
				return agent;
			},
		},
	};
	private readonly results: NodeOutcome[];
	constructor(results: NodeOutcome[] = []) {
		this.results = results;
	}
	async open(request: TestOpenRequest): Promise<AgentHandle> {
		const agent = await this.create(request);
		this.bridges.set(agent.id, request.runtimeTools);
		return agent;
	}
	protected async create(request: TestOpenRequest): Promise<AgentHandle> {
		return {
			id: `${request.runId}:agent`,
			platformReference: request.runId,
			sessionReference: request.runId,
		};
	}
	protected async restore(request: TestRestoreRequest): Promise<AgentHandle> {
		return {
			id: `${request.runId}:restored`,
			platformReference: request.sessionReference,
			sessionReference: request.sessionReference,
		};
	}
	protected bridgeFor(agent: AgentHandle): RuntimeToolBridge {
		const bridge = this.bridges.get(agent.id);
		if (!bridge) throw new Error("Fake Harness session is closed");
		return bridge;
	}
	async run(
		agent: AgentHandle,
		request: TestTurnRequest,
	): Promise<AgentTurnState> {
		const next = this.results.shift();
		if (!next) throw new Error("Fake Agent 缺少预设结果");
		await this.bridgeFor(agent).invoke({
			toolName: "submit_flow_outcome",
			arguments: {
				outcome: next.result,
				...(next.variables === undefined ? {} : { variables: next.variables }),
			},
		});
		return {
			status: "completed",
			session: {
				id: request.executionId,
				sessionReference: agent.sessionReference,
			},
		};
	}
	async close(agent: AgentHandle): Promise<void> {
		this.bridges.delete(agent.id);
		await this.release(agent);
	}
	protected async release(_agent: AgentHandle): Promise<void> {}
}

export function createTestAgentModel(
	harness: FlowAgentHarness & { extensions?: AgentHarnessExtensions },
): AgentRunModel {
	return new AgentRunModel(harness, harness.extensions);
}

/** Tests explicitly choose the local host, while Core tests inject their own ports. */
export function createTestCoordinator(
	flow: ConstructorParameters<typeof FlowCoordinator>[0],
	store: ConstructorParameters<typeof FlowCoordinator>[1],
	agentModel: AgentRunModel,
	command?: FlowHostOptions["command"],
	publisher?: FlowHostOptions["publisher"],
	onObservationError?: FlowHostOptions["onObservationError"],
	resources?: ConstructorParameters<typeof FlowCoordinator>[6],
	references?: ConstructorParameters<typeof FlowCoordinator>[7],
): FlowCoordinator {
	return createFlowCoordinator({
		flow,
		store,
		agentModel,
		command,
		publisher,
		onObservationError,
		resources,
		references,
	});
}
