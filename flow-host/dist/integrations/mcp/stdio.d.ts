#!/usr/bin/env node
import { type ExecutorBackend, type ExecutorServer } from 'ursi-executor-sdk';
export declare class McpStdioServer implements ExecutorServer {
    readonly handle: ExecutorServer['handle'];
    constructor(adapter?: ExecutorBackend, name?: string);
}
export declare function runStdio(input?: NodeJS.ReadStream & {
    fd: 0;
}, output?: NodeJS.WriteStream & {
    fd: 1;
}, server?: McpStdioServer): Promise<void>;
//# sourceMappingURL=stdio.d.ts.map