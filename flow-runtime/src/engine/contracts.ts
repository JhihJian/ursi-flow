import type { FlowVariables, OutcomeOption } from "ursi-flow-core";
import type { LogStore } from "../logs/index.ts";
import type { FlowFailure, PendingConfirm, RunResult } from "./outcome.ts";

/** 一次 Agent 调用的输入。执行器只需按 text 工作，其余字段用于回执校验与审计。 */
export interface Instruct {
	runId: string;
	stepId: string;
	nodeRef: string;
	/** 本次 Run 内第几次进入该节点，从 1 开始。 */
	visit: number;
	/** 已渲染的提示词正文。 */
	text: string;
	/** 本步允许提交的结果与说明，来自 Flow 定义的结果边。 */
	outcomes: OutcomeOption[];
	/** 当前全局变量。 */
	variables: FlowVariables;
	cwd?: string;
	/** 上一次提交被拒的原因；首次调用时为 undefined。 */
	rejection?: string;
}

/** 执行器回到引擎的结果。outcome 必须是 Instruct.outcomes 中的名字。 */
export interface ExecutorReply {
	outcome: string;
	variables?: FlowVariables;
}

/**
 * 引擎唯一的外部依赖。agentName 是 Flow 节点名，执行器据此选择或复用模型会话；
 * instruct 携带提示词、可选结果与当前变量。
 */
export interface FlowExecutor {
	prompt(agentName: string, instruct: Instruct): Promise<ExecutorReply>;
}

export interface FlowSource {
	/** Flow 标识；裸文本入口使用调用方给的名字。 */
	id: string;
	/** FLOW.md 原文。 */
	text: string;
	/** 磁盘入口路径，仅用于审计。 */
	path?: string;
}

export interface StartRequest {
	flow: FlowSource;
	runId?: string;
	variables?: FlowVariables;
	cwd?: string;
}

export interface EngineOptions {
	executor: FlowExecutor;
	store: LogStore;
	/** 同一节点连续被拒的上限，达到后本次运行失败。默认 3。 */
	maxRejectedReplies?: number;
	now?: () => string;
	newId?: () => string;
}

export interface Engine {
	/** 从 Flow 原文开始一次运行。runId 已存在时抛 conflict。 */
	start(request: StartRequest): Promise<RunResult>;
	/** 对等待人工确认的步骤提交一个结果名。非法提交抛错且不改变等待状态。 */
	respond(runId: string, stepId: string, result: string): Promise<RunResult>;
	/** 从持久化快照继续未完成的运行。 */
	resume(runId: string): Promise<RunResult>;
	/** 读取等待中的确认；不等待时返回 undefined。 */
	pending(runId: string): Promise<PendingConfirm | undefined>;
}

export type { FlowFailure, PendingConfirm, RunResult };
