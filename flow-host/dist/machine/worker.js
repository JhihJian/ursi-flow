import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExecutorUnconfirmed, FileLogStore, FlowEngine, } from "ursi-flow-runtime";
import { parseFlow } from "ursi-flow-core/runtime";
import { LocalExecutor } from "../runtime/local-executor.js";
import { AttemptUnconfirmed, PlatformExecutor } from "../runtime/platform-executor.js";
import { PiSdkHarness } from "../executor-adapters/local-pi/sdk.js";
function localExecutor(provider, dir, packageRoot) {
    return new LocalExecutor(new PiSdkHarness(provider, { trajectoryDir: join(dir, "trajectories") }), { packageRoot });
}
// Workers own a dedicated POSIX process group, including command children.
process.on("disconnect", () => process.kill(-process.pid, "SIGKILL"));
process.once("message", async (message) => {
    const { path, dir, store, job, provider, platform, resume, respond } = message;
    try {
        const text = await readFile(path, "utf8");
        const definition = parseFlow(text, flowIdOf(path));
        if (job.executorRef &&
            [...definition.nodes.values()].some((node) => node.action.kind === "confirm"))
            throw Error("平台执行器暂不支持人工确认节点");
        const engine = new FlowEngine({
            executor: job.executorRef
                ? new PlatformExecutor(platform, job.executorRef, dir, {
                    packageRoot: resolve(path, ".."),
                })
                : localExecutor(provider, dir, resolve(path, "..")),
            store: new FileLogStore(store),
        });
        const result = respond
            ? await engine.respond(job.id, respond.stepId, respond.result)
            : resume
                ? await engine.resume(job.id)
                : await engine.start({
                    flow: { id: flowIdOf(path), text, path },
                    runId: job.id,
                    variables: job.variables,
                    cwd: job.cwd,
                });
        if (result.status === "awaiting_input")
            return void process.send?.("awaiting", () => process.exit(0));
        if (result.status === "unconfirmed")
            return void process.send?.("unconfirmed", () => process.exit(75));
        if (result.status === "failed")
            return void process.send?.(result.error.message, () => process.exit(1));
        process.exit(0);
    }
    catch (e) {
        if (e instanceof AttemptUnconfirmed || e instanceof ExecutorUnconfirmed)
            return void process.send?.("unconfirmed", () => process.exit(75));
        process.send?.(String(e), () => process.exit(1));
    }
});
/** FLOW.md 的父目录名就是 Flow 标识。 */
function flowIdOf(path) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.at(-2) ?? "inline";
}
//# sourceMappingURL=worker.js.map