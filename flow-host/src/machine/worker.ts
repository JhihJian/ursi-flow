import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	ExecutorUnconfirmed,
	FileLogStore,
	FlowEngine,
	type FlowExecutor,
} from "ursi-flow-runtime";
import { parseFlow } from "ursi-flow-core/runtime";
import type { FlowVariables } from "ursi-flow-core";
import { LocalExecutor } from "../runtime/local-executor.ts";
import { AttemptUnconfirmed, PlatformExecutor } from "../runtime/platform-executor.ts";
import { PiSdkHarness, type PiProviderConfig } from "../executor-adapters/local-pi/sdk.ts";
import type { ExecutorRef, PlatformConfig } from "../executor-adapters/platform.ts";

interface JobMessage {
	path: string;
	dir: string;
	/** 日志存储根目录；运行目录是它下面的 runs/<Run ID>。 */
	store: string;
	job: {
		executorRef?: ExecutorRef;
		id: string;
		cwd: string;
		variables: Record<string, unknown>;
	};
	provider?: PiProviderConfig;
	platform?: PlatformConfig;
	resume: boolean;
	/** 应答模式：携带人工确认的步骤与结果，调用 engine.respond 续跑。 */
	respond?: { stepId: string; result: string };
}

function localExecutor(provider: PiProviderConfig, dir: string): FlowExecutor {
	return new LocalExecutor(
		new PiSdkHarness(provider, { trajectoryDir: join(dir, "trajectories") }),
	);
}

// Workers own a dedicated POSIX process group, including command children.
process.on("disconnect", () => process.kill(-process.pid, "SIGKILL"));
process.once("message", async (message: JobMessage) => {
	const { path, dir, store, job, provider, platform, resume, respond } = message;
	try {
		const text = await readFile(path, "utf8");
		const definition = parseFlow(text, flowIdOf(path));
		if (
			job.executorRef &&
			[...definition.nodes.values()].some(
				(node) => node.action.kind === "confirm",
			)
		)
			throw Error("平台执行器暂不支持人工确认节点");
		const engine = new FlowEngine({
			executor: job.executorRef
				? new PlatformExecutor(platform!, job.executorRef, dir)
				: localExecutor(provider!, dir),
			store: new FileLogStore(store),
		});
		const result = respond
			? await engine.respond(job.id, respond.stepId, respond.result)
			: resume
				? await engine.resume(job.id)
				: await engine.start({
						flow: { id: flowIdOf(path), text, path },
						runId: job.id,
						variables: job.variables as FlowVariables,
						cwd: job.cwd,
					});
		if (result.status === "awaiting_input")
			return void process.send?.("awaiting", () => process.exit(0));
		if (result.status === "unconfirmed")
			return void process.send?.("unconfirmed", () => process.exit(75));
		if (result.status === "failed")
			return void process.send?.(result.error.message, () => process.exit(1));
		process.exit(0);
	} catch (e) {
		if (e instanceof AttemptUnconfirmed || e instanceof ExecutorUnconfirmed)
			return void process.send?.("unconfirmed", () => process.exit(75));
		process.send?.(String(e), () => process.exit(1));
	}
});

/** FLOW.md 的父目录名就是 Flow 标识。 */
function flowIdOf(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.at(-2) ?? "inline";
}
