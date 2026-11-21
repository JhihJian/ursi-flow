import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { ExecutorError, type ExecutorResult, type ExecutorStartRequest, type ExecutorStatus } from "../integrations/mcp/executor.ts";
import { layout, policyFile, snapshot } from "./files.ts";
import { status, withLedger } from "./ledger.ts";

function result(attemptId: string, status: ExecutorStatus): ExecutorResult {
	return { attemptId, status, artifactDirectoryRef: `artifacts:${attemptId}`, backendRunRef: `pi:${attemptId}` };
}
async function launch(env: NodeJS.ProcessEnv, attemptId: string) {
	const entry = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
	const child = spawn(process.execPath, [fileURLToPath(entry), attemptId], {
		env: { PATH: "/usr/local/bin:/usr/bin:/bin", URSI_EXECUTOR_ROOT: env.URSI_EXECUTOR_ROOT, URSI_PI_POLICY: env.URSI_PI_POLICY },
		detached: true, stdio: "ignore",
	});
	await once(child, "spawn");
	child.unref();
}
export class PiJobs {
	private env: NodeJS.ProcessEnv;
	constructor(env = process.env) { this.env = env; }
	async start(req: ExecutorStartRequest) {
		if (Object.keys(req.runConfig ?? {}).length) throw new ExecutorError("invalid");
		const { attemptId: id, workInstruction: text } = req;
		if (!text.trim() || Buffer.byteLength(text) > 256 * 1024) throw new ExecutorError("invalid");
		const paths = layout(this.env, id);
		const { digest } = snapshot(paths.attempt);
		const hash = createHash("sha256").update(JSON.stringify(text)).digest("hex");
		const existing = withLedger(paths.root, l => {
			const row = l.get(id);
			if (row) {
				if (row.digest !== digest || row.inputHash !== hash) throw new ExecutorError("conflict");
				return status(l.current(id, paths.binding));
			}
			policyFile(this.env, paths.root);
			l.reserve(id, paths.binding, digest, hash, text);
		});
		if (existing) return result(id, existing);
		try { await launch(this.env, id); }
		catch { // spawn failed before a child was created.
			withLedger(paths.root, l => l.finish(id, "failed"));
			return result(id, "failed");
		}
		return result(id, "running");
	}
	async inspect({ attemptId: id }: { attemptId: string }) { return this.lookup(id, false); }
	async cancel({ attemptId: id }: { attemptId: string }) { return this.lookup(id, true); }
	private lookup(id: string, cancel: boolean) {
		const paths = layout(this.env, id);
		return withLedger(paths.root, l => {
			const row = l.current(id, paths.binding);
			if (cancel) l.cancel(id);
			return result(id, status(row));
		});
	}
}
