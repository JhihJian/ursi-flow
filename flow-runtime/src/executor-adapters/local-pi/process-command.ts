import { spawn } from "node:child_process";
import type {
	CommandExecutor,
	CommandRequest,
	CommandResult,
} from "../../core/contracts/types.ts";
export class ProcessCommandExecutor implements CommandExecutor {
	async execute(request: CommandRequest): Promise<CommandResult> {
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
				resolve({
					status: exitCode === 0 ? "success" : "failure",
					exitCode,
					stdout,
					stderr,
				}),
			);
			if (request.stdin !== undefined)
				child.stdin.end(JSON.stringify(request.stdin));
			else child.stdin.end();
		});
	}
}
