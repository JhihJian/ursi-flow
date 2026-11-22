import { Worker } from "node:worker_threads";
import { layout, policyFile, snapshot } from "./files.ts";
import { withLedger } from "./ledger.ts";
import type { Task } from "./runner.ts";

type Outcome = "succeeded" | "failed" | "cancelled" | "unverified";
const RUNNER = new URL(import.meta.url.endsWith(".ts") ? "./runner.ts" : "./runner.js", import.meta.url);

// Only the process that owns the live thread may stop it. After a forced stop
// an in-flight model/tool call has no confirmed outcome.
export async function supervise(thread: Worker, cancelled: () => boolean, timeout = 30 * 60_000, grace = 5000): Promise<Outcome> {
	let reason: "timeout" | "cancel" | undefined;
	let forced: NodeJS.Timeout | undefined;
	const stop = (r: NonNullable<typeof reason>) => {
		if (reason) return;
		reason = r;
		thread.postMessage("abort");
		forced = setTimeout(() => { void thread.terminate(); }, grace);
	};
	const deadline = setTimeout(() => stop("timeout"), timeout);
	const poll = setInterval(() => {
		try { if (cancelled()) stop("cancel"); } catch { /* The deadline still bounds execution. */ }
	}, 250);
	try {
		return await new Promise<Outcome>(resolve => {
			thread.once("message", (message: unknown) => {
				if (message === "aborted" && reason) resolve(reason === "cancel" ? "cancelled" : "failed");
				else if (message === "succeeded" || message === "failed") resolve(message);
				else resolve("unverified");
			});
			thread.once("error", () => resolve("unverified"));
			thread.once("exit", () => resolve("unverified"));
		});
	} finally {
		clearInterval(poll); clearTimeout(deadline); clearTimeout(forced);
		await thread.terminate(); // Stop any leaked SDK handles before reporting a terminal result.
	}
}

async function work(id: string) {
	const paths = layout(process.env, id);
	const row = withLedger(paths.root, l => l.claim(id, paths.binding));
	if (!row) return;
	let outcome: Outcome = "failed";
	try {
		const { config, digest } = snapshot(paths.attempt);
		policyFile(process.env, paths.root);
		if (digest !== row.digest) throw new Error("configuration changed");
		const task: Task = { config, workspace: paths.workspace, instruction: row.instruction, nodeContract: row.nodeContract };
		if (withLedger(paths.root, l => l.cancelRequested(id))) outcome = "cancelled";
		else {
			const thread = new Worker(RUNNER, { workerData: task });
			outcome = "unverified"; // Past dispatch, a supervisor failure is not a session failure.
			outcome = await supervise(thread, () => withLedger(paths.root, l => l.cancelRequested(id)));
		}
	} finally { withLedger(paths.root, l => l.finish(id, outcome)); }
}

if (import.meta.main) work(process.argv[2]).catch(() => { process.exitCode = 1; });
