import { PlatformAgent, PlatformClient, type ExecutorRef, type PlatformConfig } from "../executor-adapters/platform.ts";
import { AttemptUnconfirmed } from "../core/contracts/extensions.ts";
import { join } from "node:path";
import {
	AgentRunModel,
	JsonFileRunStore,
	PiSdkHarness,
	createFlowCoordinator,
	loadFlow,
} from "../index.ts";
import type { FlowVariables } from "../core/contracts/types.ts";
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
		provider, platform, resume,
	}: {
		path: string;
		dir: string;
		job: {
			executorRef?: ExecutorRef;
			id: string;
			cwd: string;
			variables: FlowVariables;
		};
		provider?: PiProviderConfig;
		platform?: PlatformConfig;
		resume: boolean;
	}) => {
		try {
			const pkg = await loadFlow(path);
			const agentModel = job.executorRef
				? new PlatformAgent(new PlatformClient(platform!), job.executorRef)
				: localAgent(provider!, dir);
			const runner = createFlowCoordinator({
				...pkg,
				store: new JsonFileRunStore(join(dir, "facts.json")),
				agentModel,
			});
			const run = resume ? await runner.resume(job.id, { cwd: job.cwd }) : await runner.run(
				{ variables: job.variables },
				{ runId: job.id, cwd: job.cwd, flowPath: pkg.path },
			);
			process.exit(run.status === "completed" ? 0 : 1);
		} catch (e) {
			process.send?.(String(e), () => process.exit(e instanceof AttemptUnconfirmed ? 75 : 1));
		}
	},
);
