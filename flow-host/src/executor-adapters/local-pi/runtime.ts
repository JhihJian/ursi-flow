import type {
	AgentRunExecutor,
	FlowExecutionExtensions,
} from "../../core/contracts/extensions.ts";
import type {
	CommandExecutor,
	FlowDefinition,
	FlowObservationEvent,
	FlowObservationPublisherApi,
	FlowPackage,
	FlowResourceContext,
	RunStore,
} from "../../core/contracts/types.ts";
import { createFlowRuntime, type FlowCoordinator } from "../../core/runtime.ts";
import { ProcessCommandExecutor } from "./process-command.ts";

export { JsonFileRunStore } from "./json-file-store.ts";
export { ProcessCommandExecutor } from "./process-command.ts";

export interface FlowHostOptions {
	store: RunStore;
	agentModel: AgentRunExecutor;
	command?: CommandExecutor;
	publisher?: FlowObservationPublisherApi;
	onObservationError?: (error: unknown, event: FlowObservationEvent) => void;
}

/** Explicit local host assembly; the Core never chooses process execution. */
export function createFlowExecutionExtensions(
	options: FlowHostOptions,
): FlowExecutionExtensions {
	const extensions: FlowExecutionExtensions = {
		confirm: true,
		command: options.command ?? new ProcessCommandExecutor(),
		parallel: {
			async execute(branches) {
				const results = await Promise.allSettled(
					branches.map((branch) => Promise.resolve().then(branch)),
				);
				const failed = results.find((result) => result.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
				return results.map((result) => {
					if (result.status !== "fulfilled")
						throw new Error("Unsettled parallel branch");
					return result.value;
				});
			},
		},
		childFlow: {
			execute: (request) =>
				coordinator(request.flow, request.references).run(request.input, {
					runId: request.runId,
					parentRunId: request.parentRunId,
					parentNodeRunId: request.parentNodeRunId,
					cwd: request.cwd,
					flowPath: request.flow.path,
				}),
			resume: (request) =>
				coordinator(request.flow, request.references).resumeChild(
					request.runId,
					request.parentRunId,
					request.parentNodeRunId,
					{ cwd: request.cwd },
				),
		},
	};
	function coordinator(
		pkg: FlowPackage,
		references: ReadonlyMap<string, FlowPackage>,
	) {
		return createFlowRuntime({
			flow: pkg.flow,
			store: options.store,
			agentExecutor: options.agentModel,
			execution: extensions,
			publisher: options.publisher,
			onObservationError: options.onObservationError,
			resources: pkg.resources,
			references,
		});
	}
	return extensions;
}

export function createFlowCoordinator(
	options: FlowHostOptions & {
		flow: FlowDefinition;
		resources?: FlowResourceContext;
		references?: ReadonlyMap<string, FlowPackage>;
	},
): FlowCoordinator {
	return createFlowRuntime({
		flow: options.flow,
		store: options.store,
		agentExecutor: options.agentModel,
		execution: createFlowExecutionExtensions(options),
		publisher: options.publisher,
		onObservationError: options.onObservationError,
		resources: options.resources,
		references: options.references,
	});
}
