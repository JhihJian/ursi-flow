import { describe, expect, it } from "vitest";
import { FakeExecutor } from "../executor/index.ts";
import type { CommandInvocation, Instruct } from "../executor/index.ts";

const instruct = (overrides: Partial<Instruct> = {}): Instruct => ({
	runId: "run-1",
	stepId: "step-1",
	nodeRef: "draft",
	visit: 1,
	text: "起草发布说明",
	outcomes: [
		{ name: "送审", description: "提交审核", variables: {} },
		{ name: "搁置", description: "暂停", variables: {} },
	],
	variables: {},
	...overrides,
});

const invocation = (overrides: Partial<CommandInvocation> = {}): CommandInvocation => ({
	runId: "run-1",
	stepId: "step-1",
	nodeRef: "check",
	nodeName: "运行测试",
	request: { command: "npm", args: ["test"] },
	...overrides,
});

describe("FakeExecutor", () => {
	it("没有脚本时按第一条结果边作答，并记录每次调用", async () => {
		const executor = new FakeExecutor();
		const reply = await executor.prompt("起草", instruct());
		expect(reply).toEqual({ outcome: "送审" });
		expect(executor.prompts).toHaveLength(1);
		expect(executor.prompts[0].agentName).toBe("起草");
		expect(executor.prompts[0].instruct.text).toBe("起草发布说明");
	});

	it("按节点名消费脚本，脚本用尽后回到默认取边", async () => {
		const executor = new FakeExecutor({
			replies: { 起草: [{ outcome: "搁置", variables: { 摘要: "暂停中" } }] },
		});
		expect(await executor.prompt("起草", instruct())).toEqual({
			outcome: "搁置",
			variables: { 摘要: "暂停中" },
		});
		expect(await executor.prompt("起草", instruct())).toEqual({ outcome: "送审" });
	});

	it("可以改成取最后一条结果边", async () => {
		const executor = new FakeExecutor({ defaultOutcome: "last" });
		expect(await executor.prompt("起草", instruct())).toEqual({ outcome: "搁置" });
	});

	it("没有结果边时直接报错，不猜一个结果", async () => {
		const executor = new FakeExecutor();
		await expect(
			executor.prompt("起草", instruct({ outcomes: [] })),
		).rejects.toThrow(/没有可选结果边/);
	});

	it("超过 prompt 上限时报错，避免循环流程跑死", async () => {
		const executor = new FakeExecutor({ maxPrompts: 2 });
		await executor.prompt("起草", instruct());
		await executor.prompt("起草", instruct());
		await expect(executor.prompt("起草", instruct())).rejects.toThrow(/成环/);
	});

	it("命令默认成功且不产生变量，变量信封节点返回空对象", async () => {
		const executor = new FakeExecutor();
		expect(await executor.command(invocation())).toEqual({
			exitCode: 0,
			stdout: "",
			stderr: "",
		});
		expect(
			await executor.command(
				invocation({ request: { command: "npm", output: "variables" } }),
			),
		).toEqual({ exitCode: 0, stdout: '{"variables":{}}', stderr: "" });
		expect(executor.commands).toHaveLength(2);
		expect(executor.commands[1].nodeName).toBe("运行测试");
	});

	it("命令结果可以按节点名预设", async () => {
		const executor = new FakeExecutor({
			commands: {
				运行测试: [{ exitCode: 1, stdout: "失败", stderr: "断言错误" }],
			},
		});
		expect(await executor.command(invocation())).toEqual({
			exitCode: 1,
			stdout: "失败",
			stderr: "断言错误",
		});
	});
});
