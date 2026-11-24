import type {
	AgentAssemblyIdentity,
	AgentAssemblyRequest,
	AgentCapabilityDeclaration,
	AgentHandle,
	AgentProfileReference,
	CommandExecutor,
	FlowAgentHarness,
	FlowDefinition,
	FlowPackage,
	FlowRunInput,
	FlowRunRecord,
	NodeOutcome,
	NodeSession,
	OutcomeOption,
	RuntimeToolBridge,
	RuntimeToolDefinition,
} from "./types.ts";

// A remote operation may still be running. Preserve its cursor for inspection.
export class AttemptUnconfirmed extends Error {}

/** 确认门禁挂起哨兵：confirm 节点渲染完成后抛出，由宿主捕获并转 waiting_input。 */
export class AwaitingInput extends Error {}

export interface AgentNodeExecutionRequest {
	attemptId?: string;
	inspectOnly?: boolean;
	runId: string;
	action: "新建Agent" | "复用Agent";
	nodeExecutionReference: string;
	/** 节点标记后缀声明的执行器名称；宿主负责解析为具体修订，未声明时宿主用默认执行器。 */
	executor?: string;
	capabilities?: AgentCapabilityDeclaration;
	profile?: AgentProfileReference;
	prompt: string;
	outcomes: OutcomeOption[];
	cwd?: string;
	allowedVariables?: ReadonlyMap<string, readonly string[]>;
	onConnection?: (connection: AgentHandle) => Promise<void>;
}

export interface AgentRunExecutor {
	readonly allocateAttemptId?: () => string;
	readonly extensions: AgentHarnessExtensions;
	preflight(
		flow: FlowDefinition,
		options?: {
			execution?: FlowExecutionExtensions;
			references?: ReadonlyMap<string, FlowPackage>;
			cwd?: string;
			sessionReference?: string;
		},
	): Promise<void>;
	start(
		runId: string,
		capabilities: AgentCapabilityDeclaration,
		existingAgentReference?: string,
		cwd?: string,
		expectedAssembly?: AgentAssemblyIdentity,
		expectedProfile?: AgentProfileReference,
		takeOverNew?: boolean,
	): Promise<void>;
	executeNode(
		request: AgentNodeExecutionRequest,
	): Promise<{ outcome: NodeOutcome; session?: NodeSession }>;
	end(runId: string): Promise<void>;
}

/** Base open inputs, without Profile or Continuity. */
export interface AgentOpenRequest {
	runId: string;
	cwd?: string;
	runtimeTools: RuntimeToolBridge;
}

/** Optional host assembly. Preflight must reject constraints it cannot enforce. */
export interface AgentAssemblyExtension {
	/** Validate a parameter-dependent Profile without invoking its resolver. */
	preflightDeferred?(
		request: {
			capabilities: AgentAssemblyRequest["capabilities"];
			profileId: string;
		},
		cwd?: string,
	): void | Promise<void>;
	preflight(request: AgentAssemblyRequest, cwd?: string): void | Promise<void>;
	open(
		request: AgentOpenRequest & { assembly: AgentAssemblyRequest },
	): Promise<AgentHandle>;
}

/**
 * Optional session continuity. Rebind replaces native tool callbacks with the
 * new node's immutable bridge; old callbacks must retain their revoked bridge.
 * Restore must return the requested session and verify expected assembly.
 */
export interface AgentRestoreRequest {
	sessionReference: string;
	assembly?: AgentAssemblyRequest;
	expectedAssembly?: AgentAssemblyIdentity;
	cwd?: string;
	/** Expected native schema, when the next Agent visit is known before restoration. */
	runtimeToolDefinitions?: readonly RuntimeToolDefinition[];
}

export interface AgentContinuityExtension {
	/** Native platforms with thread-scoped schemas must reject schema-changing reuse. */
	toolSchemaMode?: "fixed";
	/** Read-only validation before a Run is created or recovery facts are changed. */
	preflight?(request: AgentRestoreRequest): void | Promise<void>;
	rebind(agent: AgentHandle, runtimeTools: RuntimeToolBridge): Promise<void>;
	restore(
		request: AgentOpenRequest & AgentRestoreRequest,
	): Promise<AgentHandle>;
}

export interface AgentHarnessExtensions {
	assembly?: AgentAssemblyExtension;
	continuity?: AgentContinuityExtension;
}

/** Child execution must share the parent's Store and preserve parent linkage. */
export interface ChildFlowExecutionRequest {
	flow: FlowPackage;
	references: ReadonlyMap<string, FlowPackage>;
	input: FlowRunInput;
	runId: string;
	parentRunId: string;
	parentNodeRunId: string;
	cwd?: string;
}

export interface ChildFlowExecutor {
	execute(request: ChildFlowExecutionRequest): Promise<FlowRunRecord>;
	resume(request: ChildFlowExecutionRequest): Promise<FlowRunRecord>;
}

/** Preserve branch order and drain all started branches before rejecting. */
export interface ParallelExecutor {
	execute<T>(branches: readonly (() => Promise<T>)[]): Promise<T[]>;
}

export interface FlowExecutionExtensions {
	command?: CommandExecutor;
	childFlow?: ChildFlowExecutor;
	parallel?: ParallelExecutor;
	/** 宿主是否支持人工确认门禁；显式 false 时预检拒绝 confirm 节点。 */
	confirm?: boolean;
}

/** Host composition: observation readers are injected separately into inspectors. */
export interface FlowHarnessBinding {
	harness: FlowAgentHarness;
	extensions?: AgentHarnessExtensions;
}
