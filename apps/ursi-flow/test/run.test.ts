import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeExecutor } from "../executor/index.ts";
import { readFlowPackage, runFlow } from "../run.ts";
import { FileLogStore } from "../runtime/index.ts";
import type { LogEvent, StoredRun } from "../runtime/index.ts";

const dirs: string[] = [];
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "ursi-flow-run-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const example = (name: string) => readFlowPackage(new URL(`../examples/${name}`, import.meta.url).pathname);

describe("FLOW.md 到结果", () => {
	it("读取包目录时用目录名作为 Flow 标识", async () => {
		const flow = await example("ordinary");
		expect(flow.id).toBe("ordinary");
		expect(flow.text).toContain("普通流转");
		expect(flow.path?.endsWith("/examples/ordinary/FLOW.md")).toBe(true);
	});

	it("用 FakeExecutor 把 Agent 流程推到完成并落盘日志", async () => {
		const store = await tempDir();
		const flow = await example("code-change");
		const result = await runFlow({
			flow,
			executor: new FakeExecutor({
				replies: {
					完成修改: [{ outcome: "已修改", variables: { 修改记录: "改了 a.ts" } }],
					验证修改: [{ outcome: "通过" }],
				},
			}),
			store,
			variables: { 任务: "补一个测试" },
		});
		expect(result.status).toBe("completed");
		if (result.status !== "completed") return;
		expect(result.steps.map((step) => step.result.outcome)).toEqual(["已修改", "通过"]);
		expect(result.variables).toMatchObject({
			任务: "补一个测试",
			修改记录: "改了 a.ts",
		});

		const stored = (await new FileLogStore(store).load(result.runId)) as StoredRun;
		expect(stored.header.flowId).toBe("code-change");
		expect(stored.snapshot.status).toBe("completed");
		expect(stored.events[0].type).toBe("run.started");
		expect(stored.events.at(-1)?.type).toBe("run.completed");
		const seqs = stored.events.map((event: LogEvent) => event.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(stored.snapshot.seq).toBe(seqs.at(-1));

		const raw = await readFile(
			join(store, "runs", result.runId, "events.jsonl"),
			"utf8",
		);
		expect(raw.trim().split("\n").length).toBe(stored.events.length);
	});

	it("没有确认回调时停在人工确认，带回调时回答后继续到完成", async () => {
		const flow = await example("review");
		const waiting = await runFlow({
			flow,
			executor: new FakeExecutor({
				replies: { 起草: [{ outcome: "送审", variables: { 摘要: "初稿完成" } }] },
			}),
			store: await tempDir(),
			variables: { 主题: "发布说明" },
		});
		expect(waiting.status).toBe("awaiting_input");
		if (waiting.status !== "awaiting_input") return;
		expect(waiting.pending.nodeName).toBe("审核");
		expect(waiting.pending.message).toContain("初稿完成");
		expect(waiting.pending.options).toEqual(["退回", "批准"]);

		const prompts: string[] = [];
		const done = await runFlow({
			flow,
			executor: new FakeExecutor({
				replies: { 起草: [{ outcome: "送审", variables: { 摘要: "初稿完成" } }] },
			}),
			store: await tempDir(),
			variables: { 主题: "发布说明" },
			confirm: (pending) => {
				prompts.push(pending.message);
				return "批准";
			},
		});
		expect(done.status).toBe("completed");
		expect(prompts).toHaveLength(1);
	});

	it("并行命令按脚本汇总到汇合节点", async () => {
		const flow = await example("pipeline");
		const executor = new FakeExecutor({
			replies: { 准备: [{ outcome: "已准备", variables: { 清单: ["单测"] } }] },
			commands: {
				运行测试: [
					{ exitCode: 0, stdout: '{"variables":{"测试结果":"42 通过"}}', stderr: "" },
				],
				运行静态检查: [
					{ exitCode: 0, stdout: '{"variables":{"检查结果":"无告警"}}', stderr: "" },
				],
				汇总: [
					{ exitCode: 0, stdout: '{"variables":{"结论":"可以发布"}}', stderr: "" },
				],
			},
		});
		const result = await runFlow({
			flow,
			executor,
			store: await tempDir(),
			variables: { 任务: "发版检查" },
		});
		expect(result.status).toBe("completed");
		expect(executor.commands).toHaveLength(3);
		expect(executor.commands.at(-1)?.nodeName).toBe("汇总");
		const summary = executor.commands.find((call) => call.nodeName === "汇总");
		expect(summary?.request.stdin).toEqual({ test: "42 通过", lint: "无告警" });
	});

	it("同一运行标识重复执行时报冲突", async () => {
		const flow = await example("ordinary");
		const store = await tempDir();
		const options = {
			flow,
			executor: new FakeExecutor({
				replies: { 分析任务: [{ outcome: "已分析", variables: { 分析结论: "可完成" } }] },
			}),
			store,
			runId: "run-fixed",
		};
		expect((await runFlow(options)).status).toBe("completed");
		await expect(
			runFlow({ ...options, executor: new FakeExecutor() }),
		).rejects.toThrow(/冲突|已存在/);
	});
});
