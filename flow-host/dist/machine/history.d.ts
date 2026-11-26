import type { RunHeader, RunSnapshot, LogEvent } from "ursi-flow-runtime";
export interface RunFact {
    id: string;
    flowId: string;
    variables: Record<string, unknown>;
    status: string;
    phase: string;
    startedAt: string;
    completedAt?: string;
    flowPath?: string;
    cwd?: string;
    definition: Record<string, unknown>;
    error?: {
        category: string;
        summary: string;
    };
    sequence: number;
    historyCompleteness: "complete";
}
export interface NodeFact {
    id: string;
    runId: string;
    sequence: number;
    nodeRef: string;
    nodeName: string;
    actionKind: string;
    input: Record<string, unknown>;
    status: string;
    startedAt: string;
    completedAt?: string;
    outcome?: {
        result: string;
        variables?: Record<string, unknown>;
    };
    error?: {
        category: string;
        summary: string;
    };
    commandResult?: {
        status: string;
        exitCode: number;
        stdout: string;
        stderr: string;
    };
    pendingInput?: {
        message: string;
        options: string[];
    };
    attemptId?: string;
    parallelRoundId?: string;
    enteredFrom: {
        kind: string;
        ref?: string;
    };
}
/**
 * 把过程日志投影成对外历史形状。日志是唯一事实来源；
 * 这里只做形状转换，不判断路由。
 */
export declare function projectHistory(header: RunHeader, snapshot: RunSnapshot, events: readonly LogEvent[], attempts?: Readonly<Record<string, string>>): {
    runs: RunFact[];
    nodeRuns: NodeFact[];
    routeDecisions: Record<string, unknown>[];
    parallelRounds: Record<string, unknown>[];
    recoveries: Record<string, unknown>[];
    sequence: number;
};
//# sourceMappingURL=history.d.ts.map