import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseRuntimeOutcome } from "../ability/runtime-tools/bridge.ts";
import { AttemptUnconfirmed, type AgentNodeExecutionRequest, type AgentRunExecutor } from "../core/contracts/extensions.ts";
import { isRecord } from "../core/contracts/variables.ts";
import { preflightFlow } from "../core/execution/preflight.ts";

export interface ExecutorRef { id: string; revision: number }
export function parseExecutorRef(value: unknown): ExecutorRef {
	if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || value.id !== value.id.trim() ||
		typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
		Object.keys(value).some(k => k !== "id" && k !== "revision")) throw Error("executorRef 需要 id 和正整数 revision");
	return { id: value.id, revision: value.revision };
}
export function platformConfig(env = process.env) {
	const raw = env.URSI_EXECUTOR_PLATFORM_URL;
	const url = raw && URL.canParse(raw) ? new URL(raw) : undefined;
	if (!url || !["https:", "http:"].includes(url.protocol) || url.href !== `${url.origin}/`)
		throw Error("URSI_EXECUTOR_PLATFORM_URL 必须是 HTTP(S) origin");
	const token = env.URSI_EXECUTOR_PLATFORM_TOKEN?.trim();
	if (!token || /\s/.test(token)) throw Error("需要有效的 URSI_EXECUTOR_PLATFORM_TOKEN");
	return { origin: url.origin, token };
}
export type PlatformConfig = ReturnType<typeof platformConfig>;
class HttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`执行平台 HTTP ${status}`);
		this.status = status;
	}
}
export class PlatformClient {
	private readonly config: PlatformConfig;
	constructor(config: PlatformConfig) { this.config = config; }
	private async request(path: string, method: string, body?: unknown) {
		const response = await fetch(`${this.config.origin}/api/v2/${path}`, {
			method, redirect: "error", signal: AbortSignal.timeout(15_000),
			headers: { Authorization: `Bearer ${this.config.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
		return response;
	}
	async checkNodeExecutor(ref: ExecutorRef) {
		if (ref.id === "." || ref.id === "..") throw Error("无效的执行器 ID");
		const value: unknown = await (await this.request(`node-executors/${encodeURIComponent(ref.id)}/${ref.revision}`, "GET")).json();
		if (!isRecord(value) || value.id !== ref.id || value.revision !== ref.revision) throw Error("平台未确认所选执行器修订");
	}
	private path(id: string) {
		if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw Error("无效的 attemptId");
		return `executor-attempts/${id}`;
	}
	async start(id: string, body: unknown) {
		try { await (await this.request(this.path(id), "PUT", body)).body?.cancel(); }
		catch (e) {
			// 启动回执可能丢失。只用 GET 核对原 ID，不重发 PUT。
			if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408) throw e;
		}
	}
	async inspect(id: string) {
		try {
			const record: unknown = await (await this.request(this.path(id), "GET")).json();
			if (!isRecord(record) || record.attemptId !== id || typeof record.status !== "string" ||
				!["starting", "running", "unverified", "succeeded", "failed", "cancelled"].includes(record.status)) throw Error();
			return { status: record.status, artifactDirectoryId: record.artifactDirectoryId };
		} catch (e) { throw new AttemptUnconfirmed(`尝试 ${id} 状态待核实${e instanceof HttpError ? `：${e.message}` : ""}`); }
	}
	async cancel(id: string) {
		// 即使取消回执丢失，也以原尝试的查询状态为准。
		try { await (await this.request(`${this.path(id)}/cancel`, "POST")).body?.cancel(); } catch { /* inspect below */ }
		return ["cancelled", "failed", "succeeded"].includes((await this.inspect(id)).status);
	}
	async outcome(directory: unknown) {
		if (typeof directory !== "string" || !directory || directory === "." || directory === "..") throw Error("成功尝试缺少有效的 artifactDirectoryId");
		const response = await this.request(`directories/${encodeURIComponent(directory)}/file?path=flow-outcome.json`, "GET");
		return await response.json() as unknown;
	}
}

export class PlatformAgent implements AgentRunExecutor {
	readonly extensions = {};
	readonly allocateAttemptId = randomUUID;
	private readonly client: PlatformClient;
	private readonly ref: ExecutorRef;
	constructor(client: PlatformClient, ref: ExecutorRef) {
		this.client = client;
		this.ref = ref;
	}
	async preflight(...[flow, options]: Parameters<AgentRunExecutor["preflight"]>) {
		await preflightFlow(flow, options);
		for (const definition of [flow, ...Array.from(options?.references?.values() ?? [], p => p.flow)])
			for (const node of definition.nodes.values())
				if (node.action.kind === "新建Agent" && /\]\(references\//.test(node.action.prompt))
					throw Error("平台 Agent 不支持读取本地包的 references 文件");
	}
	async start() {}
	async end() {}
	async executeNode(request: AgentNodeExecutionRequest) {
		const { attemptId, inspectOnly } = request;
		if (!attemptId || request.action !== "新建Agent") throw Error("平台只支持独立的新建Agent访问");
		if (!inspectOnly) await this.client.start(attemptId, {
			executorRef: this.ref, workInstruction: { text: request.prompt, encoding: "utf-8" },
			runConfig: {
				nodeContract: {
					outcomes: request.outcomes.map(o => o.name),
					variables: [...new Set(Array.from(request.allowedVariables?.values() ?? []).flat())],
				},
			},
		});
		for (;;) {
			const state = await this.client.inspect(attemptId);
			if (state.status === "succeeded") {
				const artifact = await this.client.outcome(state.artifactDirectoryId);
				const outcome = parseRuntimeOutcome({ toolName: "submit_flow_outcome", arguments: artifact }, request.outcomes, request.allowedVariables);
				return { outcome };
			}
			if (state.status === "failed" || state.status === "cancelled") throw Error(`平台尝试 ${attemptId}: ${state.status}`);
			await delay(1000);
		}
	}
}
