import { PlatformAgent, PlatformClient, type ExecutorRef, type PlatformConfig } from "../executor-adapters/platform.ts";
import { executorNames } from "./runs.ts";
import { AttemptUnconfirmed, AwaitingInput } from "ursi-flow-core/engine";
import { join } from "node:path";
import {
	AgentRunModel,
	JsonFileRunStore,
	PiSdkHarness,
	createFlowCoordinator,
	loadFlow,
} from "../index.ts";
import type { FlowVariables } from "ursi-flow-core/engine";
import type { PiProviderConfig } from "../executor-adapters/local-pi/sdk.ts";

function localAgent(provider: PiProviderConfig, dir: string) {
	const harness = new PiSdkHarness(provider, { trajectoryDir: join(dir, "trajectories") });
	return new AgentRunModel(harness, harness.extensions);
}

// Workers own a dedicated POSIX process group, including command children.
process.on("disconnect", () => process.kill(-process.pid, "SIGKILL"));
process.once(
	"message",
	async ({
		path,
		dir,
		job,
		provider, platform, resume, respond,
	}: {
		path: string;
		dir: string;
		job: {
			executorRef?: ExecutorRef;
			nodeExecutors?: Record<string, ExecutorRef>;
			id: string;
			cwd: string;
			variables: FlowVariables;
		};
		provider?: PiProviderConfig;
		platform?: PlatformConfig;
		resume: boolean;
		/** 应答模式：携带人工确认的结果名，调用 runner.respond 续跑。 */
		respond?: { nodeRunId: string; result: string };
	}) => {
		try {
			const pkg = await loadFlow(path);
			if (!job.executorRef && executorNames(pkg).size)
				throw Error("本地 Pi 模式不支持节点级执行器声明，请改用平台执行器启动，或去掉新建Agent 标记的执行器后缀");
			const agentModel = job.executorRef
				? new PlatformAgent(new PlatformClient(platform!), job.executorRef, new Map(Object.entries(job.nodeExecutors ?? {})))
				: localAgent(provider!, dir);
			const runner = createFlowCoordinator({
				...pkg,
				store: new JsonFileRunStore(join(dir, "facts.json")),
				agentModel,
			});
			const run = respond
				? await runner.respond(job.id, respond.nodeRunId, respond.result, { cwd: job.cwd })
				: resume
					? await runner.resume(job.id, { cwd: job.cwd })
					: await runner.run(
						{ variables: job.variables },
						{ runId: job.id, cwd: job.cwd, flowPath: pkg.path },
					);
			// 挂起即干净退出：Runtime 返回等待快照（哨兵已在 continueRun 内消化），应答由 daemon 重启 worker 注入。
			if (run.phase === "awaiting_input")
				return void process.send?.("awaiting", () => process.exit(0));
			process.exit(run.status === "completed" ? 0 : 1);
		} catch (e) {
			if (e instanceof AwaitingInput)
				return void process.send?.("awaiting", () => process.exit(0));
			process.send?.(String(e), () => process.exit(e instanceof AttemptUnconfirmed ? 75 : 1));
		}
	},
);
