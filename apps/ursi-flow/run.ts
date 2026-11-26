import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { FlowVariables } from "./core/index.ts";
import type { FlowExecutor } from "./executor/index.ts";
import { FlowEngine } from "./runtime/engine/index.ts";
import type {
	LogStore,
	PendingConfirm,
	RunResult,
	StartRequest,
	FlowSource,
} from "./runtime/index.ts";
import { FileLogStore } from "./runtime/store/index.ts";

/** 确认链路失败。运行仍停在等待状态，调用方可用 runId/stepId 继续应答。 */
export class FlowRunError extends Error {
	readonly runId: string;
	readonly stepId: string;
	readonly pending: PendingConfirm;
	readonly cause: unknown;

	constructor(pending: PendingConfirm, runId: string, cause: unknown) {
		super(`处理人工确认失败：${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "FlowRunError";
		this.runId = runId;
		this.stepId = pending.stepId;
		this.pending = pending;
		this.cause = cause;
	}
}

export interface RunFlowOptions {
	flow: FlowSource;
	executor: FlowExecutor;
	/** 日志根目录或自定义存储；目录形态等价于 `new FileLogStore(dir)`。 */
	store: string | LogStore;
	variables?: FlowVariables;
	/** 命令与执行器的工作目录。 */
	cwd?: string;
	runId?: string;
	/** 遇到人工确认时如何作答：返回结果边名。缺省时直接返回等待状态。 */
	confirm?: (pending: PendingConfirm) => string | Promise<string>;
}

/**
 * FLOW.md -> 引擎 -> 最终结果。负责装配执行器与日志存储，
 * 并在调用方给出 `confirm` 时把等待中的确认问到人。
 */
export async function runFlow(options: RunFlowOptions): Promise<RunResult> {
	const engine = new FlowEngine({
		executor: options.executor,
		store:
			typeof options.store === "string"
				? new FileLogStore(options.store)
				: options.store,
	});
	const request: StartRequest = {
		flow: options.flow,
		...(options.variables === undefined ? {} : { variables: options.variables }),
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		...(options.runId === undefined ? {} : { runId: options.runId }),
	};
	let result = await engine.start(request);
	while (result.status === "awaiting_input" && options.confirm !== undefined) {
		const { runId, pending } = result;
		try {
			const answer = await options.confirm(pending);
			result = await engine.respond(runId, pending.stepId, answer);
		} catch (error) {
			throw new FlowRunError(pending, runId, error);
		}
	}
	return result;
}

/**
 * 读取一个 Flow 包：目标是目录时取其中的 `FLOW.md`，Flow 标识取目录名。
 * 目标是 `FLOW.md` 时同样以父目录名作为标识。
 */
export async function readFlowPackage(target: string): Promise<FlowSource> {
	const path = resolve(target);
	const info = await stat(path);
	const file = info.isDirectory() ? join(path, "FLOW.md") : path;
	const text = await readFile(file, "utf8");
	return { id: basename(dirname(file)), text, path: file };
}
