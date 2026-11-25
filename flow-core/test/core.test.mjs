import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ready, submit } from "ursi-flow-core";

const reviewFlow = readFileSync(new URL("../examples/review/FLOW.md", import.meta.url), "utf8");
const start = () => ready(reviewFlow, { variables: { 主题: "发布说明" } }).context;
const receipt = (context, outcome, variables) => ({
	stepId: context.current.stepId,
	outcome,
	...(variables === undefined ? {} : { variables }),
});

const freeze = (value) => {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
};

test("ready initializes globals and exposes the first agent visit", () => {
	const context = start();
	assert.equal(context.flow.id, "inline");
	assert.deepEqual(context.variables, { 主题: "发布说明", 版本: 1 });
	assert.deepEqual(context.steps, []);
	assert.equal(context.current.kind, "agent");
	assert.equal(context.current.nodeRef, "draft");
	assert.equal(context.current.prompt, "起草「发布说明」，当前版本 1。");
	assert.deepEqual(context.current.options.map(({ name }) => name), ["送审"]);
	assert.deepEqual(context.current.options[0].variables, {
		主题: { description: "写作主题" },
		版本: { description: "草稿版本" },
		摘要: { description: "送审草稿摘要" },
	});
	const options = { flowId: "manual", variables: { 主题: "手册", 版本: 3 } };
	assert.equal(ready(reviewFlow, options).context.flow.id, "manual");
	assert.match(ready(reviewFlow, options).context.current.prompt, /版本 3/);
	assert.throws(() => ready(reviewFlow), /缺少必填全局变量: 主题/);
	assert.throws(() => ready(reviewFlow, { variables: { 主题: "手册", 摘要: "无" } }), /未声明全局变量: 摘要/);
});

test("submit is atomic on invalid outcomes, invalid values and missing next input", () => {
	const draft = freeze(start());
	const before = JSON.stringify(draft);
	assert.throws(() => submit(draft, receipt(draft, "批准")), /没有结果“批准”的去向/);
	assert.throws(() => submit(draft, receipt(draft, "送审", { 错误: "未声明" })), /结果未声明变量/);
	assert.throws(() => submit(draft, receipt(draft, "送审", { 版本: NaN })), /JSON/);
	assert.throws(() => submit(draft, receipt(draft, "送审", { 版本: 2 })), /input\.摘要/);
	assert.equal(JSON.stringify(draft), before);

	const payload = receipt(draft, "送审", { 版本: 2, 摘要: "第一份" });
	const { context: review } = submit(draft, payload);
	payload.variables.摘要 = "宿主后来更改了回执";
	assert.equal(JSON.stringify(draft), before);
	assert.equal(review.current.prompt, "请审核第 2 版：第一份");
	assert.equal(review.current.kind, "confirm");
	assert.deepEqual(review.current.options.map(({ name, variables }) => [name, variables]), [["退回", {}], ["批准", {}]]);
	assert.deepEqual(review.variables, { 主题: "发布说明", 版本: 2 });
	assert.deepEqual(review.steps, [{
		stepId: draft.current.stepId,
		nodeRef: "draft",
		result: { outcome: "送审", variables: { 版本: 2, 摘要: "第一份" } },
	}]);
	assert.throws(() => submit(review, receipt(review, "退回", {})), /人工确认只提交结果名/);
});

test("a new process can rework, reject a stale visit, and approve using only JSON", () => {
	const run = (body, input) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
		import { readFileSync } from "node:fs";
		import { ready, submit } from "ursi-flow-core";
		const input = JSON.parse(readFileSync(0, "utf8"));
		${body}
	`], { cwd: new URL("../", import.meta.url), input: JSON.stringify(input), encoding: "utf8" }));
	const draft = run(`console.log(JSON.stringify(ready(input, { variables: { 主题: "手册" } }).context));`, reviewFlow);
	const advance = (context, result) => run(`console.log(JSON.stringify(submit(input.context, input.result).context));`, { context, result });
	const oldReceipt = receipt(draft, "送审", { 摘要: "第一份", 版本: 2 });
	const review = advance(draft, oldReceipt);
	const rework = advance(review, receipt(review, "退回"));
	assert.equal(rework.current.nodeRef, draft.current.nodeRef);
	assert.notEqual(rework.current.stepId, draft.current.stepId);
	assert.equal(rework.current.prompt, "起草「手册」，当前版本 2。");
	assert.throws(() => submit(rework, oldReceipt), /stepId 不匹配/);
	const reviewAgain = advance(rework, receipt(rework, "送审", { 摘要: "第二份" }));
	const approved = advance(reviewAgain, receipt(reviewAgain, "批准"));
	assert.equal(approved.current, null);
	assert.deepEqual(approved.steps.map(({ result }) => result.outcome), ["送审", "退回", "送审", "批准"]);
	assert.throws(() => submit(approved, receipt(reviewAgain, "批准")), /流程已结束/);
});

test("移除的动作与包内引用在解析期失败", () => {
	const options = { variables: { 主题: "手册" } };
	for (const [old, replacement, error] of [
		["```confirm", "```复用Agent", /动作标记无效: 复用Agent/],
		["```新建Agent", "```新建Agent:reviewer", /动作标记无效: 新建Agent:reviewer/],
		["```confirm", "```执行Flow", /动作标记无效: 执行Flow/],
		[
			"起草「{var.主题}」，当前版本 {var.版本}。",
			'{"prompt":"起草","profile":"x"}',
			/不允许字段: profile/,
		],
	]) {
		assert.throws(
			() => ready(reviewFlow.replace(old, replacement), options),
			error,
		);
	}
	// 包内相对链接不再有特殊语义，按普通文本渲染。
	const linked = ready(
		reviewFlow.replace("起草「{var.主题}」", "起草[材料](references/spec.md)「{var.主题}」"),
		options,
	).context;
	assert.match(linked.current.prompt, /\[材料\]\(references\/spec\.md\)/);
});

const pipelineFlow = readFileSync(new URL("../examples/pipeline/FLOW.md", import.meta.url), "utf8");
const pipeline = () => ready(pipelineFlow, { variables: { 任务: "发布" } }).context;

test("command steps render the request and take variables from stdout", () => {
	const first = pipeline();
	const running = submit(first, {
		stepId: first.current.stepId,
		outcome: "已准备",
		variables: { 清单: ["单元测试"] },
	}).context;
	assert.equal(running.current.kind, "parallel");
	assert.deepEqual(running.current.branches.map(({ ref }) => ref), ["test", "lint"]);
	const testBranch = running.current.branches[0];
	assert.deepEqual(testBranch.request, {
		command: "npm",
		args: ["test"],
		stdin: { 清单: ["单元测试"] },
		output: "variables",
	});
	assert.equal(running.current.branches[1].request.stdin, undefined);
	assert.equal(running.current.input.清单[0], "单元测试");
});

test("parallel steps submit every branch then prepare the join with branch results", () => {
	const first = pipeline();
	const running = submit(first, {
		stepId: first.current.stepId,
		outcome: "已准备",
		variables: { 清单: ["单元测试"] },
	}).context;
	const parallel = running.current;
	assert.equal(parallel.kind, "parallel");
	const join = submit(running, {
		stepId: parallel.stepId,
		branches: {
			test: { outcome: "已执行", variables: { 测试结果: "通过", 测试状态: "通过" } },
			lint: { outcome: "已执行", variables: { 检查结果: "无告警" } },
		},
	}).context;
	assert.equal(join.current.kind, "command");
	assert.equal(join.current.nodeRef, "merge");
	assert.deepEqual(join.current.request.stdin, {
		test: "通过",
		lint: "无告警",
	});
	// 分支各自留下一条已完成步骤记录。
	assert.deepEqual(
		join.steps.slice(-2).map(({ nodeRef, result }) => [nodeRef, result.outcome]),
		[["test", "已执行"], ["lint", "已执行"]],
	);
	const done = submit(join, {
		stepId: join.current.stepId,
		outcome: "已执行",
		variables: { 结论: "全部通过" },
	}).context;
	assert.equal(done.current, null);
	// 分支写入的全局变量在并行完成后合并，局部变量只进入下一步输入。
	assert.deepEqual(done.variables, {
		任务: "发布",
		测试状态: "通过",
	});
	assert.deepEqual(done.steps.at(-1).result.variables, { 结论: "全部通过" });
});

test("parallel rejects missing branches, bad outcomes and conflicting globals", () => {
	const first = pipeline();
	const running = submit(first, {
		stepId: first.current.stepId,
		outcome: "已准备",
		variables: { 清单: [] },
	}).context;
	const parallel = running.current;
	assert.throws(
		() => submit(running, { stepId: parallel.stepId, branches: { test: { outcome: "已执行" } } }),
		/缺少并行分支结果: lint/,
	);
	assert.throws(
		() => submit(running, {
			stepId: parallel.stepId,
			branches: { test: { outcome: "已完成" }, lint: { outcome: "已执行" } },
		}),
		/结果必须是“已执行”/,
	);
	// 两个分支提交同一个全局变量时直接失败。
	assert.throws(
		() => submit(running, {
			stepId: parallel.stepId,
			branches: {
				test: { outcome: "已执行", variables: { 测试状态: "a" } },
				lint: { outcome: "已执行", variables: { 测试状态: "b" } },
			},
		}),
		/同时写入变量: 测试状态/,
	);
});

test("readCommandVariables only accepts the variables envelope", async () => {
	const { readCommandVariables } = await import("ursi-flow-core/runtime");
	assert.deepEqual(readCommandVariables('{"variables":{"结论":"通过"}}'), { 结论: "通过" });
	assert.throws(() => readCommandVariables("{}"), /变量信封/);
	assert.throws(() => readCommandVariables("not json"), /不是有效 JSON/);
	assert.throws(() => readCommandVariables('{"结论":"通过"}'), /变量信封/);
	assert.throws(() => readCommandVariables('{"variables":1}'), /必须是 JSON 对象/);
});
