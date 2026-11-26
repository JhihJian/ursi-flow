import type { OutcomeOption } from "ursi-flow-core";
import type { NodeOutcome, RuntimeToolBridge, RuntimeToolCall, RuntimeToolDefinition, RuntimeToolResult } from "../harness.ts";
/** 接受前校验不可信的工具参数。 */
export declare function parseRuntimeOutcome(call: RuntimeToolCall, outcomes: readonly OutcomeOption[], allowedVariables?: ReadonlyMap<string, readonly string[]>): NodeOutcome;
/**
 * 一个桥只属于一次节点访问，从不改绑其他执行。宿主必须在工具回调里捕获这个实例。
 */
export declare class RuntimeOutcomeBridge implements RuntimeToolBridge {
    readonly executionId: string;
    readonly definitions: readonly RuntimeToolDefinition[];
    private readonly outcomes;
    private readonly allowedVariables?;
    private accepted?;
    private active;
    constructor(executionId: string, outcomes: readonly OutcomeOption[], allowedVariables?: ReadonlyMap<string, readonly string[]>);
    invoke(call: RuntimeToolCall): Promise<RuntimeToolResult>;
    get outcome(): NodeOutcome | undefined;
    close(): void;
}
/** 节点允许提交的变量名，按结果名分组。 */
export declare function allowedVariablesOf(outcomes: readonly OutcomeOption[]): Map<string, string[]>;
//# sourceMappingURL=bridge.d.ts.map