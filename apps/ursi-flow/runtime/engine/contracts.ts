import type { FlowVariables } from "../../core/index.ts";
import type { FlowExecutor } from "../../executor/index.ts";
import type { LogStore } from "../logs/index.ts";
import type { FlowFailure, PendingConfirm, RunResult } from "./outcome.ts";

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
	/** 从持久化快照继续未完成的运行；等待中的运行重新提问。 */
	resume(runId: string): Promise<RunResult>;
	/** 终止未完成的运行：记一条停止事实，快照进入 interrupted。 */
	stop(runId: string, reason?: string): Promise<RunResult>;
	/** 读取等待中的确认；不等待时返回 undefined。 */
	pending(runId: string): Promise<PendingConfirm | undefined>;
}

export type { FlowFailure, PendingConfirm, RunResult };
