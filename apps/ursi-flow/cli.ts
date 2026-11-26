#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join, resolve } from "node:path";
import type { FlowVariables, FlowValue } from "./core/index.ts";
import { FakeExecutor } from "./executor/index.ts";
import type { PendingConfirm, RunResult } from "./runtime/index.ts";
import { readFlowPackage, runFlow } from "./run.ts";

const USAGE = `用法：ursi-flow run <FLOW.md|包目录> [选项]

选项：
  --var <键=值>     启动变量，可重复；值按 JSON 解析，失败时按字符串处理
  --cwd <目录>      命令与执行器的工作目录，默认当前目录
  --store <目录>    运行日志根目录，默认 <cwd>/.ursi-flow
  --run-id <标识>   指定运行标识，重复使用会冲突
  --json            以 JSON 打印最终结果
  --help            显示本说明

没有接入真实 Agent 前，Agent 节点由 FakeExecutor 按第一条结果边作答。`;

const KNOWN_FLAGS = new Set(["--var", "--cwd", "--store", "--run-id"]);

interface Options {
	target: string;
	variables: FlowVariables;
	cwd: string;
	store: string;
	runId?: string;
	json: boolean;
}

function parseArguments(argv: string[]): Options | undefined {
	const [command, ...rest] = argv;
	if (command === undefined || command === "--help" || command === "-h") return undefined;
	if (command !== "run") throw new Error(`未知命令：${command}`);
	let target: string | undefined;
	const variables: FlowVariables = {};
	let cwd = process.cwd();
	let store: string | undefined;
	let runId: string | undefined;
	let json = false;
	for (let index = 0; index < rest.length; index += 1) {
		const argument = rest[index];
		if (argument === "--help" || argument === "-h") return undefined;
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (!argument.startsWith("-")) {
			if (target !== undefined) throw new Error(`只能执行一个 Flow：${argument}`);
			target = argument;
			continue;
		}
		const [flag, inline] = splitFlag(argument);
		if (!KNOWN_FLAGS.has(flag)) throw new Error(`未知选项：${flag}`);
		const value = inline ?? rest[(index += 1)];
		if (value === undefined) throw new Error(`选项缺少取值：${flag}`);
		if (flag === "--var") assignVariable(variables, value);
		else if (flag === "--cwd") cwd = resolve(value);
		else if (flag === "--store") store = resolve(value);
		else if (flag === "--run-id") runId = value;
	}
	if (target === undefined) throw new Error("缺少 FLOW.md 或包目录");
	return {
		target,
		variables,
		cwd,
		store: store ?? join(cwd, ".ursi-flow"),
		...(runId === undefined ? {} : { runId }),
		json,
	};
}

function splitFlag(argument: string): [string, string | undefined] {
	const separator = argument.indexOf("=");
	if (!argument.startsWith("--") || separator === -1) return [argument, undefined];
	return [argument.slice(0, separator), argument.slice(separator + 1)];
}

function assignVariable(variables: FlowVariables, assignment: string): void {
	const separator = assignment.indexOf("=");
	if (separator <= 0) throw new Error(`启动变量需要 <键=值>：${assignment}`);
	const key = assignment.slice(0, separator);
	const raw = assignment.slice(separator + 1);
	variables[key] = parseValue(raw);
}

function parseValue(raw: string): FlowValue {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isFlowValue(parsed)) return parsed;
	} catch {}
	return raw;
}

function isFlowValue(value: unknown): value is FlowValue {
	if (value === null) return true;
	if (["string", "number", "boolean"].includes(typeof value)) return true;
	if (Array.isArray(value)) return value.every(isFlowValue);
	if (typeof value === "object")
		return Object.values(value).every(isFlowValue);
	return false;
}

async function askConfirm(pending: PendingConfirm): Promise<string> {
	if (!stdin.isTTY) throw new Error("当前不是交互终端，无法回答人工确认");
	const options = pending.options;
	const lines = [
		`需要确认：${pending.nodeName}`,
		pending.message,
		...options.map((name, index) => `  ${index + 1}. ${name}`),
		`请输入序号或结果名（1-${options.length}）：`,
	];
	const reader = createInterface({ input: stdin, output: stdout });
	try {
		while (true) {
			const answer = (await reader.question(lines.join("\n"))).trim();
			const index = Number(answer);
			if (Number.isInteger(index) && index >= 1 && index <= options.length)
				return options[index - 1];
			if (options.includes(answer)) return answer;
			lines.length = 0;
			lines.push(`“${answer}”不是可选结果，请重新输入（1-${options.length}）：`);
		}
	} finally {
		reader.close();
	}
}

function describe(result: RunResult, flowId: string): string {
	switch (result.status) {
		case "completed": {
			const variables = Object.entries(result.variables)
				.map(([name, value]) => `  ${name} = ${JSON.stringify(value)}`)
				.join("\n");
			return [
				`完成：${flowId}，共 ${result.steps.length} 步`,
				`运行：${result.runId}`,
				variables === "" ? undefined : `变量：\n${variables}`,
			]
				.filter((line) => line !== undefined)
				.join("\n");
		}
		case "awaiting_input":
			return [
				`等待确认：${result.pending.nodeName}`,
				result.pending.message,
				`可选结果：${result.pending.options.join(" / ")}`,
				`运行：${result.runId}，步骤：${result.pending.stepId}`,
			].join("\n");
		case "failed":
			return `失败：${result.error.code} ${result.error.message}`;
		case "unconfirmed":
			return `待核实：${result.error.code} ${result.error.message}`;
		case "interrupted":
			return `已停止：${result.runId}`;
	}
}

async function main(argv: string[]): Promise<number> {
	let options: Options | undefined;
	try {
		options = parseArguments(argv);
	} catch (error) {
		process.stderr.write(`${messageOf(error)}\n\n${USAGE}\n`);
		return 64;
	}
	if (options === undefined) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	try {
		const flow = await readFlowPackage(options.target);
		const result = await runFlow({
			flow,
			executor: new FakeExecutor(),
			store: options.store,
			cwd: options.cwd,
			variables: options.variables,
			...(stdin.isTTY ? { confirm: askConfirm } : {}),
			...(options.runId === undefined ? {} : { runId: options.runId }),
		});
		process.stdout.write(
			options.json
				? `${JSON.stringify(result, null, 2)}\n`
				: `${describe(result, flow.id)}\n`,
		);
		if (result.status === "completed") return 0;
		if (result.status === "awaiting_input") return 3;
		return 1;
	} catch (error) {
		process.stderr.write(`错误：${messageOf(error)}\n`);
		return 1;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

process.exitCode = await main(process.argv.slice(2));
