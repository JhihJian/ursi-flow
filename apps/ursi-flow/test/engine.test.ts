import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FlowEngine } from "../runtime/engine/index.ts";
import type { ExecutorReply, Instruct } from "../runtime/engine/index.ts";
import { FileLogStore } from "../runtime/store/index.ts";
import type { LogEvent } from "../runtime/logs/index.ts";

const dirs: string[] = [];
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "ursi-engine-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const LINEAR = `---
name: 两步流程
description: 两个串行 Agent 节点。
variables:
  任务:
    description: 本次任务
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> analyze[分析]
  analyze -->|已分析| finishNode[收尾]
  finishNode -->|已完成| finish((结束))
\`\`\`

## 分析
\`\`\`新建Agent
分析 {var.任务}
\`\`\`
### 已分析
| 变量 | 含义 |
| --- | --- |
| 结论 | 分析结论 |

## 收尾
\`\`\`新建Agent
根据 {input.结论} 收尾
\`\`\`
### 已完成
完成。
`;

const WITH_CONFIRM = `---
name: 确认门禁
description: 挂起等待人工确认。
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> prepare[准备]
  prepare -->|已准备| gate[确认]
  gate -->|通过| finish((结束))
  gate -->|退回| prepare
\`\`\`

## 准备
\`\`\`新建Agent
准备材料
\`\`\`
### 已准备
准备完毕。

## 确认
\`\`\`confirm
请确认准备结果。
\`\`\`
### 通过
准备通过。

### 退回
需要重新准备。
`;

interface Harness {
	prompt: (instruct: Instruct) => ExecutorReply | Promise<ExecutorReply>;
	command?: (request: {
		command: string;
		args?: string[];
		stdin?: unknown;
	}) => { exitCode: number; stdout: string; stderr: string };
}

function engineOf(dir: string, harness: Harness) {
	const calls: Instruct[] = [];
	const commands: Array<{ command: string; args?: string[]; stdin?: unknown }> = [];
	const engine = new FlowEngine({
		executor: {
			async prompt(_agentName, instruct) {
				calls.push(instruct);
				return harness.prompt(instruct);
			},
			async command(invocation) {
				commands.push(invocation.request);
				return harness.command?.(invocation.request) ?? {
					exitCode: 0,
					stdout: "",
					stderr: "",
				};
			},
		},
		store: new FileLogStore(dir),
		now: () => "2024-01-01T00:00:00.000Z",
	});
	return { engine, calls, commands };
}

describe("Flow engine", () => {
	it("把 Flow 原文推进到最终结果并保留变量与步骤", async () => {
		const dir = await tempDir();
		const { engine, calls } = engineOf(dir, {
			prompt: (instruct) =>
				instruct.text.includes("分析")
					? { outcome: "已分析", variables: { 结论: "可行" } }
					: { outcome: "已完成" },
		});
		const result = await engine.start({
			flow: { id: "linear", text: LINEAR },
			runId: "run-1",
			variables: { 任务: "评估方案" },
		});
		expect(result).toMatchObject({ status: "completed", runId: "run-1" });
		if (result.status !== "completed") throw new Error("需要终态");
		// 结果变量是下一跳输入，不并入全局变量。
		expect(result.variables).toMatchObject({ 任务: "评估方案" });
		expect(result.steps.map((step) => step.result.outcome)).toEqual([
			"已分析",
			"已完成",
		]);
		// 第二次提示词带上了上一步声明的局部变量。
		expect(calls[1].text).toContain("可行");
		expect(calls.every((call) => call.runId === "run-1")).toBe(true);

		const stored = await new FileLogStore(dir).load("run-1");
		expect(stored?.snapshot.status).toBe("completed");
		expect(stored?.header.flowId).toBe("linear");
		const types = stored!.events.map((event) => event.type);
		expect(types).toEqual([
			"run.started",
			"node.entered",
			"agent.replied",
			"route.selected",
			"node.entered",
			"agent.replied",
			"route.selected",
			"run.completed",
		]);
		expect(stored!.events.map((event) => event.seq)).toEqual(
			stored!.events.map((_, index) => index + 1),
		);
	});

	it("确认门禁挂起后应答继续，非法应答不改变等待状态", async () => {
		const dir = await tempDir();
		const { engine, calls } = engineOf(dir, { prompt: () => ({ outcome: "已准备" }) });
		const started = await engine.start({
			flow: { id: "gate", text: WITH_CONFIRM },
			runId: "run-2",
		});
		expect(started.status).toBe("awaiting_input");
		if (started.status !== "awaiting_input") throw new Error("需要等待状态");
		expect(started.pending).toMatchObject({
			nodeName: "确认",
			message: "请确认准备结果。",
			options: ["通过", "退回"],
		});
		await expect(engine.respond("run-2", started.pending.stepId, "不合法")).rejects.toThrow(
			"无效的确认结果",
		);
		await expect(engine.respond("run-2", "other-step", "通过")).rejects.toThrow(
			"确认步骤与当前等待不匹配",
		);
		expect(await engine.pending("run-2")).toMatchObject({ options: ["通过", "退回"] });
		expect(calls).toHaveLength(1);

		const done = await engine.respond("run-2", started.pending.stepId, "通过");
		expect(done.status).toBe("completed");
		const stored = await new FileLogStore(dir).load("run-2");
		expect(stored!.events.map((event) => event.type)).toContain("confirm.answered");
	});

	it("连续提交不允许的结果时本轮失败并保留最后一次拒绝原因", async () => {
		const dir = await tempDir();
		const { engine } = engineOf(dir, { prompt: () => ({ outcome: "不存在的结果" }) });
		const result = await engine.start({
			flow: { id: "bad", text: WITH_CONFIRM },
			runId: "run-3",
		});
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("需要失败状态");
		expect(result.error.code).toBe("rejected_results");
		expect(result.error.message).toContain("不存在的结果");
		const stored = await new FileLogStore(dir).load("run-3");
		expect(
			stored!.events.filter((event) => event.type === "agent.rejected"),
		).toHaveLength(3);
	});

	it("重启后从快照恢复：等待中的运行直接给出待决确认，终态不重跑", async () => {
		const dir = await tempDir();
		const first = engineOf(dir, { prompt: () => ({ outcome: "已准备" }) });
		await first.engine.start({ flow: { id: "gate2", text: WITH_CONFIRM }, runId: "run-4" });

		const second = engineOf(dir, {
			prompt: () => {
				throw new Error("恢复等待中的运行不应调用执行器");
			},
		});
		const resumed = await second.engine.resume("run-4");
		expect(resumed.status).toBe("awaiting_input");
		expect(second.calls).toHaveLength(0);

		await expect(first.engine.start({ flow: { id: "gate2", text: WITH_CONFIRM }, runId: "run-4" })).rejects.toThrow(
			"运行已存在",
		);
	});

	it("日志按行追加，事件序号与快照序号一致", async () => {
		const dir = await tempDir();
		const { engine } = engineOf(dir, {
			prompt: (instruct) =>
				instruct.text.includes("分析")
					? { outcome: "已分析", variables: { 结论: "x" } }
					: { outcome: "已完成" },
		});
		await engine.start({
			flow: { id: "log", text: LINEAR },
			runId: "run-5",
			variables: { 任务: "x" },
		});
		const raw = await readFile(join(dir, "runs", "run-5", "events.jsonl"), "utf8");
		const events = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as LogEvent);
		const snapshot = JSON.parse(
			await readFile(join(dir, "runs", "run-5", "snapshot.json"), "utf8"),
		) as { seq: number };
		expect(snapshot.seq).toBe(events.length);
		expect(events.at(-1)?.type).toBe("run.completed");
	});
});
const PIPELINE = `---
name: 检查流水线
description: 准备后并行跑两项命令检查，再汇总结论。
variables:
  任务:
    description: 本次任务
  测试状态:
    description: 最近一次测试结论
    default: 未测
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> prepare[准备]
  prepare -->|已准备| checks{{并行}}
  checks --> test[运行测试]
  checks --> lint[运行静态检查]
  test -->|已执行| merge[汇总]
  lint -->|已执行| merge
  merge -->|已执行| finish((结束))
\`\`\`

## 准备

\`\`\`新建Agent
为「{var.任务}」准备检查清单。
\`\`\`

### 已准备

| 变量 | 含义 |
| --- | --- |
| 清单 | 待检查项 |

清单已准备好。

## 运行测试

\`\`\`执行自定义命令
{
  "command": "npm",
  "args": ["test"],
  "stdin": {"清单": "{input.清单}"},
  "output": "variables"
}
\`\`\`

### 已执行

| 变量 | 含义 |
| --- | --- |
| 测试结果 | 测试输出摘要 |

命令也可以同时写全局变量：\`测试状态\` 由分支直接提交，并行完成后合并到全局。

## 运行静态检查

\`\`\`执行自定义命令
{
  "command": "npm",
  "args": ["run", "check"],
  "output": "variables"
}
\`\`\`

### 已执行

| 变量 | 含义 |
| --- | --- |
| 检查结果 | 静态检查摘要 |

## 汇总

\`\`\`执行自定义命令
{
  "command": "node",
  "args": ["scripts/merge.mjs"],
  "stdin": {
    "test": "{branch.test.测试结果}",
    "lint": "{branch.lint.检查结果}"
  },
  "output": "variables"
}
\`\`\`

### 已执行

| 变量 | 含义 |
| --- | --- |
| 结论 | 汇总结论 |
`;

describe("命令与并行", () => {
	it("命令步骤执行已渲染的请求，并从 stdout 信封取变量", async () => {
		const dir = await tempDir();
		const { engine, commands } = engineOf(dir, {
			prompt: () => ({ outcome: "已准备", variables: { 清单: ["单元测试"] } }),
			command: (request) => ({
				exitCode: 0,
				stdout: JSON.stringify({
					variables:
						request.command === "node"
							? { 结论: "通过" }
							: request.args?.[0] === "test"
								? { 测试结果: "通过" }
								: { 检查结果: "无告警" },
				}),
				stderr: "",
			}),
		});
		const result = await engine.start({
			flow: { id: "pipeline", text: PIPELINE },
			runId: "run-cmd",
			variables: { 任务: "发布" },
			cwd: "/work",
		});
		expect(result.status).toBe("completed");
		expect(commands.map((request) => request.command)).toEqual([
			"npm",
			"npm",
			"node",
		]);
		expect(commands[0].stdin).toEqual({ 清单: ["单元测试"] });
		expect(commands[2].stdin).toEqual({ test: "通过", lint: "无告警" });

		const stored = await new FileLogStore(dir).load("run-cmd");
		const types = stored!.events.map((event) => event.type);
		expect(types).toContain("parallel.entered");
		expect(types.filter((type) => type === "command.finished")).toHaveLength(3);
		const finished = stored!.events.find(
			(event) => event.type === "command.finished" && event.nodeRef === "merge",
		);
		expect(finished).toMatchObject({ exitCode: 0, variables: { 结论: "通过" } });
	});

	it("分支结果不合法时本次运行失败，不生成汇合步骤", async () => {
		const dir = await tempDir();
		const { engine, commands } = engineOf(dir, {
			prompt: () => ({ outcome: "已准备", variables: { 清单: [] } }),
			command: () => ({
				exitCode: 0,
				stdout: JSON.stringify({ variables: { 测试状态: "通过" } }),
				stderr: "",
			}),
		});
		const result = await engine.start({
			flow: { id: "pipeline", text: PIPELINE },
			runId: "run-bad",
			variables: { 任务: "发布" },
		});
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("需要失败状态");
		expect(result.error.code).toBe("rejected_results");
		expect(commands).toHaveLength(2);
	});

	it("命令退出码不为 0 仍按已执行继续，退出码留在日志里", async () => {
		const dir = await tempDir();
		const { engine } = engineOf(dir, {
			prompt: () => ({ outcome: "已准备", variables: { 清单: [] } }),
			command: (request) => ({
				exitCode: 1,
				stdout: JSON.stringify({
					variables:
						request.command === "node"
							? { 结论: "失败" }
							: request.args?.[0] === "test"
								? { 测试结果: "失败" }
								: { 检查结果: "失败" },
				}),
				stderr: "boom",
			}),
		});
		const result = await engine.start({
			flow: { id: "pipeline", text: PIPELINE },
			runId: "run-exit",
			variables: { 任务: "发布" },
		});
		expect(result.status).toBe("completed");
		const stored = await new FileLogStore(dir).load("run-exit");
		const finish = stored!.events.filter((event) => event.type === "command.finished");
		expect(finish.every((event) => event.exitCode === 1)).toBe(true);
	});

	it("命令输出不是变量信封时本次运行失败", async () => {
		const dir = await tempDir();
		const { engine } = engineOf(dir, {
			prompt: () => ({ outcome: "已准备", variables: { 清单: [] } }),
			command: () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
		});
		const result = await engine.start({
			flow: { id: "pipeline", text: PIPELINE },
			runId: "run-badjson",
			variables: { 任务: "发布" },
		});
		expect(result).toMatchObject({
			status: "failed",
			error: { code: "executor_failed" },
		});
	});
});
