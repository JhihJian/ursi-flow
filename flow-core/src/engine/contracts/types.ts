import type {
	AgentCapabilityDeclaration,
	AgentProfileReference,
	CommandRequest,
	FlowAction,
	FlowDefinition,
	FlowDestination,
	FlowValue,
	FlowVariables,
} from "../../types.ts";

export type {
	AgentAction,
	AgentActionKind,
	AgentCapabilityDeclaration,
	AgentProfileReference,
	CommandAction,
	CommandRequest,
	ConfirmAction,
	FlowAction,
	FlowDefinition,
	FlowDestination,
	FlowNode,
	FlowReferenceAction,
	FlowValue,
	FlowVariableDeclaration,
	FlowVariableDeclarations,
	FlowVariables,
	ParallelStart,
	TemplateContext,
} from "../../types.ts";

/** Host-resolved identity of a profile-backed Agent assembly. */
export interface AgentAssemblyIdentity {
	hostId: string;
	pluginId: string;
	pluginVersion: string;
	pluginDigest: string;
	profileId: string;
	paramsDigest: string;
	resolvedCapabilityDigest: string;
}

/** Files adjacent to a directory-based Flow entry. */
export interface FlowResourceContext {
	packageRoot: string;
	resourcePaths: ReadonlyMap<string, string>;
}

/** A Flow package: parsed definition, entry path, and validated resources. */
export interface FlowPackage {
	flow: FlowDefinition;
	path: string;
	resources: FlowResourceContext;
}

/** A Flow package together with its loaded reference closure. */
export interface LoadedFlow extends FlowPackage {
	/** 引用闭包：从本 Flow 出发可传递到达的全部被引用 Flow 及其资源。 */
	references: ReadonlyMap<string, FlowPackage>;
}

export interface OutcomeOption {
	name: string;
	description: string;
}

export interface NodeOutcome {
	result: string;
	variables?: FlowVariables;
}

export interface AgentConnection {
	id: string;
	platformReference: string;
	sessionReference?: string;
	assembly?: AgentAssemblyIdentity;
}

export type AgentHandle = AgentConnection;

export interface RuntimeToolDefinition {
	name: string;
	description: string;
	/** JSON Schema object. Hosts must preserve its constraints when registering tools. */
	inputSchema: { [key: string]: FlowValue };
}

export interface RuntimeToolCall {
	callId?: string;
	toolName: string;
	/** Untrusted host input: the Runtime validates before accepting an outcome. */
	arguments: unknown;
}

export interface RuntimeToolResult {
	content?: FlowValue;
	details?: FlowValue;
	stopExecution?: boolean;
}

export interface RuntimeToolBridge {
	readonly definitions: readonly RuntimeToolDefinition[];
	invoke(call: RuntimeToolCall): Promise<RuntimeToolResult>;
}

export interface AgentAssemblyRequest {
	capabilities: AgentCapabilityDeclaration;
	profile?: AgentProfileReference;
}

export interface AgentTurnState {
	status: "completed" | "failed" | "interrupted" | "unknown";
	session?: NodeSession;
	error?: { summary: string };
}

/** Minimal semantic contract between Flow Core and an Agent Harness. */
export interface FlowAgentHarness {
	open(request: {
		runId: string;
		cwd?: string;
		runtimeTools: RuntimeToolBridge;
	}): Promise<AgentHandle>;
	run(
		agent: AgentHandle,
		request: {
			executionId: string;
			prompt: string;
		},
	): Promise<AgentTurnState>;
	close(agent: AgentHandle): Promise<void>;
}

export interface NodeSession {
	id: string;
	sessionReference?: string;
	interactionReference?: string;
}

export interface UnifiedMessage {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	content: FlowValue;
}

export interface CommandResult {
	status: "success" | "failure";
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface CommandExecutor {
	execute(request: CommandRequest): Promise<CommandResult>;
}

export type RunStatus = "running" | "completed" | "failed" | "interrupted";

export type RunPhase =
	| "starting"
	| "executing_node"
	| "waiting_parallel"
	| "routing"
	| "awaiting_input"
	| "completed"
	| "failed"
	| "interrupted";

export type NodeRunStatus = "running" | "completed" | "failed" | "interrupted";

export type ParallelRoundStatus =
	| "running"
	| "joining"
	| "completed"
	| "failed"
	| "interrupted";

export type FlowErrorCategory =
	| "agent_capability"
	| "agent_execution"
	| "command_execution"
	| "outcome_validation"
	| "route_not_found"
	| "parallel_configuration"
	| "flow_reference"
	| "command_interrupted"
	| "recovery"
	| "persistence"
	| "legacy"
	| "variable_reference"
	| "variable_type"
	| "variable_conflict"
	| "variable_persistence"
	| "variable_recovery"
	| "unknown";

export interface FlowError {
	category: FlowErrorCategory;
	summary: string;
}

export type NodeRunSource =
	| { kind: "start" }
	| {
			kind: "route";
			routeDecisionId: string;
			sourceNodeRunId: string;
	  }
	| {
			kind: "parallel";
			parallelRoundId: string;
			branchNodeRunIds?: string[];
	  }
	| { kind: "recovery"; nodeRunId: string };

/** An immutable record of one actual visit to a Flow work node. */
export interface NodeRunRecord {
	id: string;
	/** Platform identity committed before dispatch, reused on inspection and cancellation. */
	attemptId?: string;
	runId: string;
	/** Stable fact order within the Run. */
	sequence: number;
	/** Human-readable node name captured from the Flow definition for display. */
	nodeName?: string;
	/** Stable internal reference used for routing and programmatic association. */
	nodeRef: string;
	actionKind: FlowAction["kind"];
	input: FlowValue;
	status: NodeRunStatus;
	startedAt: string;
	completedAt?: string;
	outcome?: NodeOutcome;
	error?: FlowError;
	/** Execution evidence references. Full evidence stays with the host. */
	session?: NodeSession;
	/** Profile/plugin assembly used for this Agent visit. */
	agentAssembly?: AgentAssemblyIdentity;
	retryOf?: string;
	enteredFrom: NodeRunSource;
	parallelRoundId?: string;
	/** 业务变量之外的命令执行证据。 */
	commandResult?: CommandResult;
	/** 执行Flow 节点启动的子 Run 标识。 */
	childRunId?: string;
	/** 确认门禁挂起信息：等人选边期间记录，消费后清除。 */
	pendingInput?: PendingInput;
}

/** 确认门禁挂起信息：message 为渲染后的提问正文，options 为可选结果边。 */
export interface PendingInput {
	message: string;
	options: string[];
}

/** A persisted edge selection. It is never reconstructed from a current Flow file. */
export interface RouteDecisionRecord {
	id: string;
	runId: string;
	sequence: number;
	sourceNodeRunId: string;
	result: string;
	destination: FlowDestination;
	/** Set only when this decision created a concrete parallel execution round. */
	parallelRoundId?: string;
	selectedAt: string;
}

/** One concrete visit to a static parallel entry point. */
export interface ParallelRoundRecord {
	id: string;
	runId: string;
	/** Stable fact order for this concrete parallel entry. */
	sequence: number;
	parallelRef: string;
	input: FlowValue;
	status: ParallelRoundStatus;
	startedAt: string;
	completedAt?: string;
	error?: FlowError;
	branchNodeRunIds: Record<string, string>;
	branchStatuses: Record<string, NodeRunStatus>;
	joinNodeRunId?: string;
	joinInput?: FlowValue;
	joinOutcome?: NodeOutcome;
	variablePatches?: Record<string, FlowVariables>;
	sourceNodeRunId?: string;
}

export interface RunRecoveryRecord {
	id: string;
	runId: string;
	sequence: number;
	interruptedNodeRunId?: string;
	strategy: "retry_agent" | "fail_command" | "continue_routing" | "inspect_attempt";
	resumedAt: string;
	summary: string;
}

export interface FlowRunInput {
	variables?: FlowVariables;
}

/** Serializable Flow definition captured with a Run for historical inspection. */
export interface FlowDefinitionSnapshot {
	id: string;
	name: string;
	description: string;
	startNodeRef: string;
	version: string;
	nodes: Array<{
		ref: string;
		name: string;
		actionKind: string;
		results: Array<{ name: string; destination: FlowDestination }>;
	}>;
	edges: Array<{
		id: string;
		from: string;
		to: string;
		result?: string;
		kind: "node" | "parallel" | "finish" | "branch" | "join";
	}>;
	parallels: Array<{
		ref: string;
		branches: string[];
		joinRef: string;
	}>;
	mermaid: string;
}

/**
 * Current Run snapshot. Historical facts live in NodeRun, RouteDecision,
 * ParallelRound and RunRecovery records, rather than in the current cursor.
 */
export interface FlowRunRecord {
	id: string;
	flowId: string;
	/** Immutable content fingerprint calculated from the parsed Flow definition. */
	flowVersion: string;

	variables?: FlowVariables;
	status: RunStatus;
	phase: RunPhase;
	/** Monotonically incremented after every successful state-fact commit. */
	sequence: number;
	/** Legacy snapshots are queryable but cannot claim complete route/version history. */
	historyCompleteness: "complete" | "legacy";
	startedAt: string;
	completedAt?: string;
	/** CLI recovery metadata. SDK hosts may omit these fields. */
	flowPath?: string;
	cwd?: string;
	sessionReference?: string;
	/** Definition snapshot retained so historical Runs remain inspectable after file moves. */
	definition?: FlowDefinitionSnapshot;
	/** Last durably bound Agent visit; null means no Agent has been bound yet. */
	agentNodeRunId?: string | null;
	/** Current Agent assembly identity, when the host provides one. */
	agentAssembly?: AgentAssemblyIdentity;
	/** Profile reference used by the current Agent binding. */
	agentProfile?: AgentProfileReference;
	currentNodeRef?: string;
	currentInput?: FlowValue;
	currentNodeRunId?: string;
	currentParallelRoundId?: string;
	error?: FlowError;
	/** 引用执行时记录的父 Run 关联。子 Run 只随父 Run 恢复。 */
	parentRunId?: string;
	parentNodeRunId?: string;
	/** @deprecated 仅供历史快照读取，新运行时不再使用。 */
	currentParallelRound?: ParallelRoundRecord;
}

/** All writes in a commit become visible together, or not at all. */
export interface RunFactCommit {
	run: FlowRunRecord;
	expectedSequence: number;
	nodeRuns?: NodeRunRecord[];
	routeDecisions?: RouteDecisionRecord[];
	parallelRounds?: ParallelRoundRecord[];
	recoveries?: RunRecoveryRecord[];
}

/** A read-consistent persisted aggregate for one Run. */
export interface FlowRunSnapshot {
	run: FlowRunRecord;
	nodeRuns: NodeRunRecord[];
	routeDecisions: RouteDecisionRecord[];
	parallelRounds: ParallelRoundRecord[];
	recoveries: RunRecoveryRecord[];
}

export interface RunStore {
	createRun(run: FlowRunRecord): Promise<void>;
	commit(fact: RunFactCommit): Promise<void>;
	getRun(runId: string): Promise<FlowRunRecord | undefined>;
	getRunSnapshot(runId: string): Promise<FlowRunSnapshot | undefined>;
	listAllRuns(): Promise<FlowRunRecord[]>;
	listRuns(flowId: string): Promise<FlowRunRecord[]>;
	listRunningRuns(): Promise<FlowRunRecord[]>;
	listNodeRuns(runId: string): Promise<NodeRunRecord[]>;
	listRouteDecisions(runId: string): Promise<RouteDecisionRecord[]>;
	listParallelRounds(runId: string): Promise<ParallelRoundRecord[]>;
	listRunRecoveries(runId: string): Promise<RunRecoveryRecord[]>;
	/** 查询引用执行产生的子 Run，按启动时间排序。 */
	listChildRuns(parentRunId: string): Promise<FlowRunRecord[]>;
	/** Compatibility and test setup APIs. Coordinators must use commit instead. */
	updateRun(run: FlowRunRecord): Promise<void>;
	createNodeRun(record: NodeRunRecord): Promise<void>;
	updateNodeRun(record: NodeRunRecord): Promise<void>;
}

export type FlowRunLiveness = "live" | "stale";

export interface FlowRunPresence {
	/** Run identity from the persisted FlowRunRecord. */
	runId: string;
	rootRunId: string;
	flowId: string;
	cwd: string;
	storePath: string;
	flowPath?: string;
	pid: number;
	runtimeInstanceId: string;
	startedAt: string;
	heartbeatAt: string;
	leaseExpiresAt: string;
	liveness: FlowRunLiveness;
}

export interface FlowRunDiscoverySource {
	presence?: FlowRunPresence;
	store: RunStore;
}

export interface FlowRunDiscovery {
	list(): Promise<FlowRunDiscoverySource[]>;
	find(runId: string): Promise<FlowRunDiscoverySource | undefined>;
}

export interface FlowRunSummary {
	id: string;
	flowId: string;
	flowVersion: string;
	status: RunStatus;
	phase: RunPhase;
	sequence: number;
	historyCompleteness: "complete" | "legacy";
	startedAt: string;
	completedAt?: string;
	error?: FlowError;
}

export type FlowRunLocation =
	| {
			kind: "node";
			nodeRunId?: string;
			nodeName?: string;
			nodeRef: string;
	  }
	| {
			kind: "parallel";
			parallelRoundId: string;
			parallelRef: string;
	  }
	| { kind: "none" };

export interface FlowNodeEvidenceSummary {
	sessionReference?: string;
	interactionReference?: string;
	commandOutputAvailable: boolean;
}

export interface FlowNodeRunView {
	id: string;
	runId: string;
	sequence: number;
	nodeName?: string;
	nodeRef: string;
	actionKind: FlowAction["kind"];
	input: FlowValue;
	status: NodeRunStatus;
	startedAt: string;
	completedAt?: string;
	result?: string;
	error?: FlowError;
	session?: NodeSession;
	retryOf?: string;
	enteredFrom: NodeRunSource;
	parallelRoundId?: string;
	childRunId?: string;
}

/** Stable, adapter-independent projection of one Run's persisted facts. */
export interface FlowRunHistory {
	run: FlowRunSummary;
	nodeRuns: FlowNodeRunView[];
	routeDecisions: RouteDecisionRecord[];
	parallelRounds: ParallelRoundRecord[];
	recoveries: RunRecoveryRecord[];
	current: FlowRunLocation;
	evidence: Record<string, FlowNodeEvidenceSummary>;
}

export interface FlowNodeEvidence {
	runId: string;
	nodeRunId: string;
	nodeName?: string;
	nodeRef: string;
	status: NodeRunStatus;
	input: FlowValue;
	outcome?: NodeOutcome;
	error?: FlowError;
	session?: NodeSession;
	messages?: UnifiedMessage[];
	commandResult?: {
		status: "success" | "failure";
		exitCode: number | null;
		stdout: string;
		stderr: string;
	};
}

export interface FlowNodeEvidenceReader {
	getNodeSession(session: NodeSession): Promise<UnifiedMessage[]>;
}

export interface FlowNodeEvidenceAccessRequest {
	runId: string;
	nodeRun: NodeRunRecord;
}

export type FlowNodeEvidenceAuthorizer = (
	request: FlowNodeEvidenceAccessRequest,
) => boolean | Promise<boolean>;

export interface FlowRunInspectorApi {
	listRecentRuns(limit?: number): Promise<FlowRunSummary[]>;
	inspectRun(runId: string): Promise<FlowRunHistory | undefined>;
	inspectNodeEvidence(
		runId: string,
		nodeRunId: string,
	): Promise<FlowNodeEvidence | undefined>;
}

export type FlowObservationEventType =
	| "run.started"
	| "run.awaiting_input"
	| "run.resumed"
	| "run.completed"
	| "run.failed"
	| "run.interrupted"
	| "node.started"
	| "node.completed"
	| "node.failed"
	| "node.interrupted"
	| "route.selected"
	| "parallel.started"
	| "parallel.completed";

export interface FlowObservationEvent {
	type: FlowObservationEventType;
	runId: string;
	flowId: string;
	/** Run-local commit water mark. Events are ordered by this value. */
	sequence: number;
	occurredAt: string;
	status: RunStatus;
	phase: RunPhase;
	nodeRunId?: string;
	/** User-facing name. `nodeRef` remains available as a stable internal key. */
	nodeName?: string;
	nodeRef?: string;
	parallelRoundId?: string;
	result?: string;
	destination?: FlowDestination;
	nodeStatus?: NodeRunStatus;
	parallelStatus?: ParallelRoundStatus;
	summary: string;
}

export interface FlowObservationSubscription {
	unsubscribe(): void;
}

export interface FlowObservationPublisherApi {
	publish(event: FlowObservationEvent): void;
	subscribe(
		runId: string,
		listener: (event: FlowObservationEvent) => void,
	): FlowObservationSubscription;
}

export interface FlowObservationPublisherOptions {
	onError?: (error: unknown, event: FlowObservationEvent) => void;
}
