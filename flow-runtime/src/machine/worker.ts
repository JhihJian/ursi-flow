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

// Workers own a dedicated POSIX process group, including command children.
process.on("disconnect", () => process.kill(-process.pid, "SIGKILL"));
process.once(
	"message",
	async ({
		path,
		dir,
		job,
		provider,
	}: {
		path: string;
		dir: string;
		job: {
			id: string;
			cwd: string;
			variables: FlowVariables;
		};
		provider: PiProviderConfig;
	}) => {
		try {
			const pkg = await loadFlow(path),
				harness = new PiSdkHarness(provider);
			const runner = createFlowCoordinator({
				...pkg,
				store: new JsonFileRunStore(join(dir, "facts.json")),
				agentModel: new AgentRunModel(harness, harness.extensions),
			});
			const run = await runner.run(
				{ variables: job.variables },
				{ runId: job.id, cwd: job.cwd, flowPath: pkg.path },
			);
			process.exit(run.status === "completed" ? 0 : 1);
		} catch (e) {
			process.send?.(String(e), () => process.exit(1));
		}
	},
);
