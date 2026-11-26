import type {
	CompletedStep,
	CurrentStep,
	FlowContext,
	FlowVariables,
} from "../../core/index.ts";
import type { FlowFailure, PendingConfirm } from "../engine/outcome.ts";

/** 运行头。Flow 原文一并保存，包被删除或修订后仍能重建这次运行。 */
export interface RunHeader {
	runId: string;
	flowId: string;
	flowPath?: string;
	cwd?: string;
	/** 启动时的 FLOW.md 原文。 */
	flowText: string;
	variables: FlowVariables;
	startedAt: string;
}

export type LogDestination =
	| { kind: "node"; ref: string }
	| { kind: "parallel"; ref: string }
	| { kind: "finish" };

interface LogEventBase {
	runId: string;
	/** 同一运行内单调递增，从 1 开始。 */
	seq: number;
	at: string;
}

export interface RunStarted {
	type: "run.started";
	variables: FlowVariables;
}

export interface NodeEntered {
	type: "node.entered";
	stepId: string;
	nodeRef: string;
	nodeName: string;
	kind: CurrentStep["kind"];
	/** 本次 Run 内第几次进入该节点。并行步骤按汇合节点计。 */
	serve?: number;
	/** Agent 与确认步骤的渲染文本。 */
	prompt?: string;
	variables: FlowVariables;
}

export interface ParallelEntered {
	type: "parallel.entered";
	stepId: string;
	parallelRef: string;
	joinName: string;
	branches: Array<{ ref: string; nodeRef: string; name: string; request: unknown }>;
}

export interface CommandStarted {
	type: "command.started";
	stepId: string;
	nodeRef: string;
	nodeName: string;
	/** 并行分支所属的并行开始点。 */
	parallelRef?: string;
	request: unknown;
	cwd?: string;
}

export interface CommandFinished {
	type: "command.finished";
	stepId: string;
	nodeRef: string;
	nodeName: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	variables?: FlowVariables;
}

export interface AgentReplied {
	type: "agent.replied";
	stepId: string;
	nodeRef: string;
	serve: number;
	outcome: string;
	variables?: FlowVariables;
}

export interface AgentRejected {
	type: "agent.rejected";
	stepId: string;
	nodeRef: string;
	serve: number;
	reason: string;
}

export interface ConfirmPending {
	type: "confirm.pending";
	stepId: string;
	nodeRef: string;
	nodeName: string;
	message: string;
	options: string[];
}

export interface ConfirmAnswered {
	type: "confirm.answered";
	stepId: string;
	result: string;
}

export interface RouteSelected {
	type: "route.selected";
	stepId: string;
	nodeRef: string;
	outcome: string;
	destination: LogDestination;
	variables: FlowVariables;
}

export interface RunResumed {
	type: "run.resumed";
	fromStepId?: string;
	/** 恢复前的运行状态，用于区分“待核实”与普通续跑。 */
	fromStatus?: RunStatus;
}

export interface RunCompleted {
	type: "run.completed";
	variables: FlowVariables;
	steps: CompletedStep[];
}

export interface RunFailed extends FlowFailure {
	type: "run.failed";
}

export interface RunUnconfirmed extends FlowFailure {
	type: "run.unconfirmed";
}

export interface RunStopped {
	type: "run.stopped";
	reason?: string;
}

/** 过程日志的全部实体。写入时由 store 补上 runId、seq 与 at。 */
export type LogEventPayload =
	| RunStarted
	| NodeEntered
	| ParallelEntered
	| CommandStarted
	| CommandFinished
	| AgentReplied
	| AgentRejected
	| ConfirmPending
	| ConfirmAnswered
	| RouteSelected
	| RunResumed
	| RunCompleted
	| RunFailed
	| RunUnconfirmed
	| RunStopped;

export type LogEvent = LogEventPayload & LogEventBase;

export type RunStatus =
	| "running"
	| "awaiting_input"
	| "completed"
	| "failed"
	| "unconfirmed"
	| "interrupted";

/** 可重建下一步的完整状态。Flow Core 的 stepId 不可注入，恢复只能依赖这份快照。 */
export interface RunSnapshot {
	status: RunStatus;
	context: FlowContext;
	pending?: PendingConfirm;
	failure?: FlowFailure;
	/** 最后写入的事件序号。 */
	seq: number;
	updatedAt: string;
}

export interface StoredRun {
	header: RunHeader;
	snapshot: RunSnapshot;
	events: LogEvent[];
}

/** 日志的写入端口。引擎只依赖它，具体落在哪个介质由 store 决定。 */
export interface LogStore {
	/** 新建运行目录与头文件。运行已存在时抛错。 */
	create(header: RunHeader): Promise<void>;
	/** 追加一条过程事件。 */
	append(runId: string, event: LogEvent): Promise<void>;
	/** 覆盖保存可恢复快照。 */
	saveSnapshot(runId: string, snapshot: RunSnapshot): Promise<void>;
	/** 读取运行头、快照与全部事件。运行不存在时返回 undefined。 */
	load(runId: string): Promise<StoredRun | undefined>;
}
