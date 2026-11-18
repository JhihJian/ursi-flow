import { join } from "node:path";
import {
	AgentRunModel,
	HeadlessPi,
	JsonFileRunStore,
	createFlowCoordinator,
	loadFlow,
} from "../index.ts";
import type { FlowVariables } from "../core/contracts/types.ts";

// Workers own a dedicated POSIX process group, including Pi and command children.
process.on("disconnect", () => process.kill(-process.pid, "SIGKILL"));
process.once(
	"message",
	async ({
		path,
		dir,
		job,
	}: {
		path: string;
		dir: string;
		job: {
			id: string;
			cwd: string;
			variables: FlowVariables;
			config: { model: string };
		};
	}) => {
		try {
			const pkg = await loadFlow(path),
				harness = new HeadlessPi({ model: job.config.model });
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
