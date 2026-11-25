import type { CompletedStep, CurrentStep, FlowVariables, OutcomeOption } from "ursi-flow-core";

export type { CompletedStep, CurrentStep, FlowVariables, OutcomeOption };

/** 人工确认门禁的待决事实。 */
export interface PendingConfirm {
	stepId: string;
	nodeRef: string;
	nodeName: string;
	message: string;
	options: string[];
}

export interface FlowFailure {
	code:
		| "flow_invalid"
		| "executor_failed"
		| "executor_unconfirmed"
		| "rejected_results"
		| "store_failed";
	message: string;
	/** 失败发生在哪个步骤。定义非法时没有步骤。 */
	stepId?: string;
	nodeRef?: string;
}

export type RunResult =
	| {
			status: "completed";
			runId: string;
			variables: FlowVariables;
			steps: CompletedStep[];
	  }
	| { status: "awaiting_input"; runId: string; pending: PendingConfirm }
	| { status: "failed"; runId: string; error: FlowFailure }
	| { status: "unconfirmed"; runId: string; error: FlowFailure }
	| { status: "interrupted"; runId: string };
