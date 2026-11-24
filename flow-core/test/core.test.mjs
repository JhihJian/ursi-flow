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

test("unsupported actions and package features fail before reaching the first visit", () => {
	const options = { variables: { 主题: "手册" } };
	for (const [old, replacement, error] of [
		["```confirm", "```复用Agent", /不支持节点 review 的动作/],
		["```新建Agent", "```新建Agent:reviewer", /专用执行器/],
		["请审核第", "请查看[材料](references/spec.md)，审核第", /包内资料引用/],
		["variables:\n  主题", "capabilities:\n  tools: [business-tool]\nvariables:\n  主题", /宿主业务能力装配/],
	]) {
		assert.throws(() => ready(reviewFlow.replace(old, replacement), options), error);
	}
});
