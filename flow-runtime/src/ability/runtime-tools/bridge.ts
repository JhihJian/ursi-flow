import type {
	NodeOutcome,
	OutcomeOption,
	RuntimeToolBridge,
	RuntimeToolCall,
	RuntimeToolDefinition,
	RuntimeToolResult,
} from "../../core/contracts/types.ts";
import {
	isRecord,
	validateFlowValue,
	validateVariableName,
	validateVariables,
} from "../../core/contracts/variables.ts";

/** Validate untrusted tool arguments before accepting or copying any outcome. */
export function parseRuntimeOutcome(
	call: RuntimeToolCall,
	outcomes: readonly OutcomeOption[],
	allowedVariables?: ReadonlyMap<string, readonly string[]>,
): NodeOutcome {
	if (call.toolName !== "submit_flow_outcome")
		throw new Error(`不支持的 Runtime 工具: ${call.toolName}`);
	validateFlowValue(call.arguments);
	if (!isRecord(call.arguments)) throw new Error("工具参数必须是 JSON 对象");
	for (const key of Object.keys(call.arguments)) {
		if (key !== "outcome" && key !== "variables")
			throw new Error(`工具参数不允许字段: ${key}`);
	}
	const { outcome, variables } = call.arguments;
	if (typeof outcome !== "string") throw new Error("outcome 必须是字符串");
	if (!outcomes.some((option) => option.name === outcome))
		throw new Error(`节点不允许结果: ${outcome}`);
	if (variables === undefined) return { result: outcome };
	validateVariables(variables);
	if (allowedVariables) {
		const allowed = allowedVariables.get(outcome) ?? [];
		for (const name of Object.keys(variables)) {
			if (!allowed.includes(name))
				throw new Error(`结果 ${outcome} 不允许变量: ${name}`);
		}
	}
	return { result: outcome, variables: structuredClone(variables) };
}

/**
 * One bridge belongs to exactly one NodeRun. It is never retargeted to another
 * execution. Hosts must capture this instance in each native tool callback.
 * Acceptance is synchronous; persistence/routing happens after the turn settles.
 */
export class RuntimeOutcomeBridge implements RuntimeToolBridge {
	readonly executionId: string;
	readonly definitions: readonly RuntimeToolDefinition[];
	private readonly outcomes: readonly OutcomeOption[];
	private readonly allowedVariables?: ReadonlyMap<string, readonly string[]>;
	private accepted?: NodeOutcome;
	private active = true;

	constructor(
		executionId: string,
		outcomes: readonly OutcomeOption[],
		allowedVariables?: ReadonlyMap<string, readonly string[]>,
	) {
		this.executionId = executionId;
		if (!executionId) throw new Error("Runtime 工具桥必须绑定节点执行标识");
		if (!outcomes.length || outcomes.some((option) => !option.name))
			throw new Error("Runtime 结果工具必须声明非空结果集合");
		if (new Set(outcomes.map((option) => option.name)).size !== outcomes.length)
			throw new Error("Runtime 结果工具不能声明重复结果");
		this.outcomes = structuredClone(outcomes);
		this.allowedVariables = allowedVariables
			? new Map(
					[...allowedVariables].map(([name, values]) => [name, [...values]]),
				)
			: undefined;
		const names = this.allowedVariables
			? [...new Set([...this.allowedVariables.values()].flat())]
			: undefined;
		for (const name of names ?? []) validateVariableName(name);
		this.definitions = freezeJson([
			{
				name: "submit_flow_outcome",
				description:
					"Submit the current Flow node result exactly once after completing its work.",
				inputSchema: {
					type: "object",
					properties: {
						outcome: {
							type: "string",
							enum: this.outcomes.map((option) => option.name),
						},
						variables: {
							type: "object",
							...(names
								? {
										properties: Object.fromEntries(
											names.map((name) => [name, {}]),
										),
										additionalProperties: false,
									}
								: {}),
						},
					},
					required: ["outcome"],
					additionalProperties: false,
				},
			},
		]);
	}

	async invoke(call: RuntimeToolCall): Promise<RuntimeToolResult> {
		if (!this.active)
			throw new Error(`Flow 节点工具桥已关闭: ${this.executionId}`);
		if (this.accepted) throw new Error("一个 Agent 节点只能提交一次结果");
		this.accepted = parseRuntimeOutcome(
			call,
			this.outcomes,
			this.allowedVariables,
		);
		return {
			content: `Flow outcome submitted: ${this.accepted.result}`,
			stopExecution: true,
		};
	}

	/** A detached snapshot; callers cannot mutate the accepted submission. */
	get outcome(): NodeOutcome | undefined {
		return this.accepted && structuredClone(this.accepted);
	}

	/** Revoke before releasing a session or beginning the next node. Idempotent. */
	close(): void {
		this.active = false;
	}
}

function freezeJson<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeJson(child);
		Object.freeze(value);
	}
	return value;
}
