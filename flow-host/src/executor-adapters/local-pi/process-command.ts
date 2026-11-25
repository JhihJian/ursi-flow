import { spawn } from "node:child_process";
import type { CommandRequest } from "ursi-flow-core";

export interface CommandExecution {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** 用当前用户权限运行命令节点；stdin 以 UTF-8 JSON 写入。 */
export class ProcessCommandExecutor {
	async execute(request: CommandRequest): Promise<CommandExecution> {
		return await new Promise((resolve, reject) => {
			const child = spawn(request.command, request.args ?? [], {
				stdio: ["pipe", "pipe", "pipe"],
				cwd: request.cwd,
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.once("error", reject);
			child.stdin.once("error", (error: NodeJS.ErrnoException) => {
				if (error.code !== "EPIPE") reject(error);
			});
			child.once("close", (exitCode) =>
				resolve({ exitCode: exitCode ?? 0, stdout, stderr }),
			);
			if (request.stdin !== undefined)
				child.stdin.end(JSON.stringify(request.stdin));
			else child.stdin.end();
		});
	}
}
