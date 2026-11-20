import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
	ExecutorAdapter,
	ExecutorError,
	McpStdioServer,
	parseAttemptRequest,
	parseStartRequest,
	type RuntimeClient,
	type RuntimeJob,
} from "../src/integrations/mcp/index.ts";

const attemptId = "123e4567-e89b-12d3-a456-426614174000";
const dirs: string[] = [];
const env = (root: string) => ({
	URSI_EXECUTOR_ROOT: root,
	URSI_EXECUTOR_FLOW: "material-review",
	URSI_EXECUTOR_FLOW_REVISION: "revision-1",
	URSI_FLOW_HOME: join(root, "flow-home"),
});

async function workspace(root: string) {
	const dir = join(root, attemptId, "workspace");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}
function job(cwd: string, status = "running"): RuntimeJob {
	return {
		id: attemptId,
		flow: "material-review",
		revision: "revision-1",
		cwd,
		variables: { 任务: "review this" },
		status,
	};
}
class FakeRuntime implements RuntimeClient {
	readonly starts: unknown[][] = [];
	readonly gets: string[] = [];
	readonly stops: string[] = [];
	constructor(private readonly value: RuntimeJob) {}
	async startPinned(...args: [string, string, string, Record<string, unknown>, string]) {
		this.starts.push(args);
		return this.value;
	}
	async get(id: string) {
		this.gets.push(id);
		return this.value;
	}
	async stop(id: string) {
		this.stops.push(id);
		return this.value;
	}
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("executor MCP adapter", () => {
	it("只接受固定的 lower-case UUID 参数形状", () => {
		const valid = {
			attemptId,
			workspaceRef: `workspace:${attemptId}`,
			artifactDirectoryRef: `artifacts:${attemptId}`,
			workInstruction: { text: "review this", encoding: "utf-8" },
		};
		expect(parseStartRequest(valid)).toEqual(valid);
		expect(() => parseStartRequest({ ...valid, extra: true })).toThrowError(
			new ExecutorError("invalid"),
		);
		expect(() => parseStartRequest({ ...valid, attemptId: attemptId.toUpperCase() })).toThrow();
		expect(() => parseAttemptRequest({ attemptId, extra: true })).toThrow();
	});

	it("把 Workbench 工作目录和任务文本交给 daemon，并返回同值 JSON text", async () => {
		const root = await mkdtemp(join(tmpdir(), "ursi-mcp-"));
		dirs.push(root);
		const cwd = await workspace(root);
		const runtime = new FakeRuntime(job(cwd));
		const adapter = new ExecutorAdapter(env(root), runtime);
		const value = await adapter.start({
			attemptId,
			workspaceRef: `workspace:${attemptId}`,
			artifactDirectoryRef: `artifacts:${attemptId}`,
			workInstruction: { text: "review this", encoding: "utf-8" },
		});
		expect(runtime.starts[0]).toEqual([
			attemptId,
			"material-review",
			cwd,
			{ 任务: "review this" },
			"revision-1",
		]);
		expect(value).toMatchObject({
			attemptId,
			status: "running",
			artifactDirectoryRef: `artifacts:${attemptId}`,
			backendRunRef: `flow:${attemptId}`,
		});
	});

	it("inspect/cancel 先校验目录和 job 身份，配置漂移不会影响其他 run", async () => {
		const root = await mkdtemp(join(tmpdir(), "ursi-mcp-"));
		dirs.push(root);
		const cwd = await workspace(root);
		const runtime = new FakeRuntime(job(cwd));
		const adapter = new ExecutorAdapter(env(root), runtime);
		expect((await adapter.inspect({ attemptId })).status).toBe("running");
		expect((await adapter.cancel({ attemptId })).status).toBe("running");
		expect(runtime.gets).toEqual([attemptId, attemptId]);
		expect(runtime.stops).toEqual([attemptId]);

		const drifted = new FakeRuntime({ ...job(cwd), flow: "other-flow" });
		await expect(new ExecutorAdapter(env(root), drifted).inspect({ attemptId })).rejects.toMatchObject({ code: "conflict" });
		expect(drifted.stops).toHaveLength(0);
	});

	it("拒绝 symlink 工作区", async () => {
		const root = await mkdtemp(join(tmpdir(), "ursi-mcp-"));
		dirs.push(root);
		const target = join(root, "target");
		await mkdir(target, { recursive: true });
		await mkdir(join(root, attemptId));
		await symlink(target, join(root, attemptId, "workspace"));
		const runtime = new FakeRuntime(job(target));
		await expect(new ExecutorAdapter(env(root), runtime).inspect({ attemptId })).rejects.toMatchObject({ code: "unavailable" });
		expect(runtime.gets).toHaveLength(0);
	});

	it("实现 MCP 生命周期、工具列表和工具错误 envelope", async () => {
		const root = await mkdtemp(join(tmpdir(), "ursi-mcp-"));
		dirs.push(root);
		const cwd = await workspace(root);
		const server = new McpStdioServer(new ExecutorAdapter(env(root), new FakeRuntime(job(cwd))));
		expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toMatchObject({ error: { code: -32002 } });
		expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
		expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
		const list = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect(list).toMatchObject({ result: { tools: [{ name: "executor_start" }, { name: "executor_inspect" }, { name: "executor_cancel" }] } });
		const good = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "executor_start", arguments: { attemptId, workspaceRef: `workspace:${attemptId}`, artifactDirectoryRef: `artifacts:${attemptId}`, workInstruction: { text: "review this", encoding: "utf-8" } } } });
		if (!good || typeof good !== "object" || !("result" in good)) throw new Error("missing MCP result");
		const result = (good as { result: { structuredContent: unknown; content: [{ text: string }] } }).result;
		expect(result.content[0].text).toBe(JSON.stringify(result.structuredContent));
		const bad = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "executor_inspect", arguments: { attemptId, extra: true } } });
		expect(bad).toMatchObject({ result: { isError: true, content: [{ text: JSON.stringify({ code: "invalid" }) }] } });
	});
});
