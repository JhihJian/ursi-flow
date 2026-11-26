import { isRecord, validateFlowValue, validateVariableName, validateVariables, } from "ursi-flow-core/runtime";
/** 接受前校验不可信的工具参数。 */
export function parseRuntimeOutcome(call, outcomes, allowedVariables) {
    if (call.toolName !== "submit_flow_outcome")
        throw new Error(`不支持的 Runtime 工具: ${call.toolName}`);
    validateFlowValue(call.arguments);
    if (!isRecord(call.arguments))
        throw new Error("工具参数必须是 JSON 对象");
    for (const key of Object.keys(call.arguments)) {
        if (key !== "outcome" && key !== "variables")
            throw new Error(`工具参数不允许字段: ${key}`);
    }
    const { outcome, variables } = call.arguments;
    if (typeof outcome !== "string")
        throw new Error("outcome 必须是字符串");
    if (!outcomes.some((option) => option.name === outcome))
        throw new Error(`节点不允许结果: ${outcome}`);
    if (variables === undefined)
        return { result: outcome };
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
 * 一个桥只属于一次节点访问，从不改绑其他执行。宿主必须在工具回调里捕获这个实例。
 */
export class RuntimeOutcomeBridge {
    executionId;
    definitions;
    outcomes;
    allowedVariables;
    accepted;
    active = true;
    constructor(executionId, outcomes, allowedVariables) {
        this.executionId = executionId;
        if (!executionId)
            throw new Error("Runtime 工具桥必须绑定节点执行标识");
        if (!outcomes.length || outcomes.some((option) => !option.name))
            throw new Error("Runtime 结果工具必须声明非空结果集合");
        if (new Set(outcomes.map((option) => option.name)).size !== outcomes.length)
            throw new Error("Runtime 结果工具不能声明重复结果");
        this.outcomes = structuredClone(outcomes);
        this.allowedVariables = allowedVariables
            ? new Map([...allowedVariables].map(([name, values]) => [name, [...values]]))
            : undefined;
        const names = this.allowedVariables
            ? [...new Set([...this.allowedVariables.values()].flat())]
            : undefined;
        for (const name of names ?? [])
            validateVariableName(name);
        this.definitions = freezeJson([
            {
                name: "submit_flow_outcome",
                description: "Submit the current Flow node result exactly once after completing its work.",
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
                                    properties: Object.fromEntries(names.map((name) => [name, {}])),
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
    async invoke(call) {
        if (!this.active)
            throw new Error(`Flow 节点工具桥已关闭: ${this.executionId}`);
        if (this.accepted)
            throw new Error("一个 Agent 节点只能提交一次结果");
        try {
            this.accepted = parseRuntimeOutcome(call, this.outcomes, this.allowedVariables);
        }
        catch (error) {
            if (process.env.URSI_FLOWD_DEBUG === "1")
                console.error("bridge reject", call.arguments, error instanceof Error ? error.message : error);
            throw error;
        }
        return {
            content: `Flow outcome submitted: ${this.accepted.result}`,
            stopExecution: true,
        };
    }
    get outcome() {
        return this.accepted && structuredClone(this.accepted);
    }
    close() {
        this.active = false;
    }
}
/** 节点允许提交的变量名，按结果名分组。 */
export function allowedVariablesOf(outcomes) {
    return new Map(outcomes.map((option) => [option.name, Object.keys(option.variables)]));
}
function freezeJson(value) {
    if (value && typeof value === "object") {
        for (const child of Object.values(value))
            freezeJson(child);
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=bridge.js.map