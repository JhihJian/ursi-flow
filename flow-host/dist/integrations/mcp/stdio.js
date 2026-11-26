#!/usr/bin/env node
import { createExecutorServer, runStdio as runServer } from 'ursi-executor-sdk';
import { EXECUTOR_SERVER_NAME, EXECUTOR_SERVER_VERSION, ExecutorAdapter } from "./executor.js";
export class McpStdioServer {
    handle;
    constructor(adapter, name = EXECUTOR_SERVER_NAME) {
        // Discovery must work before the daemon and workspace are configured.
        const backend = () => adapter ??= new ExecutorAdapter();
        this.handle = createExecutorServer({
            name, version: EXECUTOR_SERVER_VERSION,
            start: req => backend().start(req),
            inspect: req => backend().inspect(req),
            cancel: req => backend().cancel(req),
        }).handle;
    }
}
export function runStdio(input = process.stdin, output = process.stdout, server = new McpStdioServer()) {
    return runServer(input, output, server);
}
if (import.meta.main)
    runStdio().catch(() => { process.exitCode = 1; });
//# sourceMappingURL=stdio.js.map