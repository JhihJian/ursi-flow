import { spawn } from "node:child_process";
/** 用当前用户权限运行命令节点；stdin 以 UTF-8 JSON 写入。 */
export class ProcessCommandExecutor {
    async execute(request) {
        return await new Promise((resolve, reject) => {
            const child = spawn(request.command, request.args ?? [], {
                stdio: ["pipe", "pipe", "pipe"],
                cwd: request.cwd,
            });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                stdout += chunk;
            });
            child.stderr.on("data", (chunk) => {
                stderr += chunk;
            });
            child.once("error", reject);
            child.stdin.once("error", (error) => {
                if (error.code !== "EPIPE")
                    reject(error);
            });
            child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? 0, stdout, stderr }));
            if (request.stdin !== undefined)
                child.stdin.end(JSON.stringify(request.stdin));
            else
                child.stdin.end();
        });
    }
}
//# sourceMappingURL=process-command.js.map