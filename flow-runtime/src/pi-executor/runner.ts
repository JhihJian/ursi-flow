import { parentPort, workerData } from "node:worker_threads";
import type { PiConfig } from "./session.ts";

export interface Task { config: PiConfig; workspace: string; instruction: string }

if (parentPort) {
	const port = parentPort;
	const controller = new AbortController();
	port.once("message", () => controller.abort());
	const { config, workspace, instruction }: Task = workerData;
	try {
		const { runPi } = await import("./session.ts");
		controller.signal.throwIfAborted();
		await runPi(config, workspace, instruction, controller.signal);
		port.postMessage("succeeded");
	} catch (e) {
		const aborted = controller.signal.aborted && (e === controller.signal.reason || (e instanceof Error && e.name === "AbortError"));
		port.postMessage(aborted ? "aborted" : "failed");
	} finally { port.close(); }
}
