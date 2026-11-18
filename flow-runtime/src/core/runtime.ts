import type {
	AgentRunExecutor,
	FlowExecutionExtensions,
} from "./contracts/extensions.ts";
import type {
	FlowDefinition,
	FlowObservationEvent,
	FlowObservationPublisherApi,
	FlowPackage,
	FlowResourceContext,
	RunStore,
} from "./contracts/types.ts";
import { FlowCoordinator } from "./execution/runtime.ts";

export interface CoreRuntimeOptions {
	flow: FlowDefinition;
	store: RunStore;
	agentExecutor: AgentRunExecutor;
	execution?: FlowExecutionExtensions;
	publisher?: FlowObservationPublisherApi;
	onObservationError?: (error: unknown, event: FlowObservationEvent) => void;
	resources?: FlowResourceContext;
	references?: ReadonlyMap<string, FlowPackage>;
}

export function createFlowRuntime(
	options: CoreRuntimeOptions,
): FlowCoordinator {
	return new FlowCoordinator(
		options.flow,
		options.store,
		options.agentExecutor,
		options.execution ?? {},
		options.publisher,
		options.onObservationError,
		options.resources,
		options.references,
	);
}

export { FlowCoordinator };
