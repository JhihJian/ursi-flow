const ACTION_KIND = {
    agent: "新建Agent",
    confirm: "confirm",
    command: "执行自定义命令",
    parallel: "并行",
};
/**
 * 把过程日志投影成对外历史形状。日志是唯一事实来源；
 * 这里只做形状转换，不判断路由。
 */
export function projectHistory(header, snapshot, events, attempts = {}) {
    const run = {
        id: header.runId,
        flowId: header.flowId,
        variables: snapshot.context.variables,
        status: snapshot.status,
        phase: snapshot.status,
        startedAt: header.startedAt,
        ...(header.flowPath === undefined ? {} : { flowPath: header.flowPath }),
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        definition: definitionOf(snapshot),
        sequence: snapshot.seq,
        historyCompleteness: "complete",
    };
    if (snapshot.status === "completed" || snapshot.status === "failed")
        run.completedAt = snapshot.updatedAt;
    if (snapshot.failure)
        run.error = {
            category: snapshot.failure.code,
            summary: snapshot.failure.message,
        };
    const nodeRuns = [];
    const byStep = new Map();
    const routeDecisions = [];
    const parallelRounds = [];
    const recoveries = [];
    let sequence = 0;
    for (const event of events) {
        sequence = Math.max(sequence, event.seq);
        switch (event.type) {
            case "node.entered": {
                const existing = byStep.get(event.stepId);
                if (existing)
                    break;
                const record = {
                    id: event.stepId,
                    runId: event.runId,
                    sequence: event.seq,
                    nodeRef: event.nodeRef,
                    nodeName: event.nodeName,
                    actionKind: ACTION_KIND[event.kind] ?? event.kind,
                    input: {},
                    status: "running",
                    startedAt: event.at,
                    enteredFrom: { kind: "route" },
                    ...(event.kind === "parallel"
                        ? { enteredFrom: { kind: "parallel" } }
                        : {}),
                };
                nodeRuns.push(record);
                byStep.set(event.stepId, record);
                break;
            }
            case "agent.replied": {
                const record = byStep.get(event.stepId);
                if (!record)
                    break;
                record.outcome = {
                    result: event.outcome,
                    ...(event.variables === undefined
                        ? {}
                        : { variables: event.variables }),
                };
                record.status = "completed";
                record.completedAt = event.at;
                break;
            }
            case "agent.rejected": {
                const record = byStep.get(event.stepId);
                if (!record)
                    break;
                record.error = {
                    category: "agent_execution",
                    summary: event.reason,
                };
                break;
            }
            case "command.finished": {
                const record = byStep.get(event.stepId);
                if (!record)
                    break;
                record.commandResult = {
                    status: event.exitCode === 0 ? "success" : "failure",
                    exitCode: event.exitCode,
                    stdout: event.stdout,
                    stderr: event.stderr,
                };
                record.outcome = {
                    result: "已执行",
                    ...(event.variables === undefined
                        ? {}
                        : { variables: event.variables }),
                };
                record.status = "completed";
                record.completedAt = event.at;
                break;
            }
            case "confirm.pending": {
                const record = byStep.get(event.stepId);
                if (!record)
                    break;
                record.pendingInput = {
                    message: event.message,
                    options: event.options,
                };
                break;
            }
            case "confirm.answered": {
                const record = byStep.get(event.stepId);
                if (!record)
                    break;
                delete record.pendingInput;
                record.outcome = { result: event.result };
                record.status = "completed";
                record.completedAt = event.at;
                break;
            }
            case "parallel.entered": {
                const branchIds = Object.fromEntries(event.branches.map((branch) => [branch.ref, branch.ref]));
                parallelRounds.push({
                    id: event.stepId,
                    runId: event.runId,
                    sequence: event.seq,
                    parallelRef: event.parallelRef,
                    input: {},
                    status: "running",
                    startedAt: event.at,
                    branchNodeRunIds: branchIds,
                    branchStatuses: Object.fromEntries(event.branches.map((branch) => [branch.ref, "running"])),
                    joinNodeRunId: event.stepId,
                });
                break;
            }
            case "route.selected": {
                routeDecisions.push({
                    id: `${event.stepId}-route`,
                    runId: event.runId,
                    sequence: event.seq,
                    sourceNodeRunId: event.stepId,
                    result: event.outcome,
                    destination: event.destination,
                    selectedAt: event.at,
                });
                break;
            }
            case "run.resumed": {
                recoveries.push({
                    id: `${event.runId}-${event.seq}`,
                    runId: event.runId,
                    sequence: event.seq,
                    ...(event.fromStepId === undefined
                        ? {}
                        : { interruptedNodeRunId: event.fromStepId }),
                    strategy: event.fromStatus === "unconfirmed"
                        ? "inspect_attempt"
                        : "continue_routing",
                    resumedAt: event.at,
                    summary: "继续执行未完成的运行",
                });
                break;
            }
            case "run.failed": {
                for (const record of nodeRuns)
                    if (record.status === "running") {
                        record.status = "failed";
                        record.completedAt = event.at;
                        record.error = {
                            category: event.code,
                            summary: event.message,
                        };
                    }
                break;
            }
            default:
                break;
        }
    }
    for (const record of nodeRuns) {
        const attemptId = attempts[record.id];
        if (attemptId)
            record.attemptId = attemptId;
        if (record.status === "running" && snapshot.status === "awaiting_input")
            record.status = "running";
    }
    return {
        runs: [run],
        nodeRuns,
        routeDecisions,
        parallelRounds,
        recoveries,
        sequence,
    };
}
function definitionOf(snapshot) {
    const flow = snapshot.context.flow;
    return {
        id: flow.id,
        name: flow.name,
        description: flow.description,
        startNodeRef: flow.startNodeRef,
        nodes: Object.entries(flow.nodes).map(([ref, node]) => ({
            ref,
            name: node.name,
            actionKind: ACTION_KIND[node.kind] ?? node.kind,
            results: node.routes.map((route) => ({
                name: route.name,
                destination: route.destination,
            })),
        })),
        parallels: Object.values(flow.parallels),
        mermaid: "",
    };
}
//# sourceMappingURL=history.js.map