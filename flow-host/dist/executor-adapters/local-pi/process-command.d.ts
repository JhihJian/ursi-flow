import type { CommandRequest } from "ursi-flow-core";
export interface CommandExecution {
    exitCode: number;
    stdout: string;
    stderr: string;
}
/** 用当前用户权限运行命令节点；stdin 以 UTF-8 JSON 写入。 */
export declare class ProcessCommandExecutor {
    execute(request: CommandRequest): Promise<CommandExecution>;
}
//# sourceMappingURL=process-command.d.ts.map