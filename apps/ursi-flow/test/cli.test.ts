import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const root = new URL("..", import.meta.url).pathname;
const dirs: string[] = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "ursi-flow-cli-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
	return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

const CONFIRM_FLOW = `---
name: 确认门禁
description: 一步 Agent 后等待人工确认。
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
准备完成。

## 确认
\`\`\`confirm
请确认准备结果。
\`\`\`
### 通过
通过。

### 退回
退回。
`;

describe("ursi-flow 命令行", () => {
	it("跑完一个 Agent 流程并以 JSON 输出结果", () => {
		const store = tempDir();
		const result = run([
			"run",
			"examples/ordinary",
			"--store",
			store,
			"--var",
			"任务=发布说明",
			"--json",
		]);
		expect(result.status).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.status).toBe("completed");
		expect(parsed.steps).toHaveLength(2);
		expect(parsed.variables.任务).toBe("发布说明");
	});

	it("非交互终端遇到确认时报告等待状态并返回 3", () => {
		const dir = tempDir();
		const flowDir = join(dir, "gate");
		mkdirSync(flowDir);
		writeFileSync(join(flowDir, "FLOW.md"), CONFIRM_FLOW);
		const result = run(["run", flowDir, "--store", join(dir, "store")]);
		expect(result.status).toBe(3);
		expect(result.stdout).toContain("等待确认");
		expect(result.stdout).toContain("通过 / 退回");
	});

	it("运行失败时打印原因与运行标识", () => {
		const result = run([
			"run",
			"examples/simplify",
			"--store",
			join(tempDir(), "store"),
			"--var",
			"任务=x",
		]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("失败：");
		expect(result.stdout).toMatch(/运行：[\w-]+/);
	});

	it("缺少参数时打印用法，未知选项返回 64", () => {
		const usage = run([]);
		expect(usage.status).toBe(0);
		expect(usage.stdout).toContain("用法：ursi-flow run");
		const unknown = run(["run", "examples/ordinary", "--unknown"]);
		expect(unknown.status).toBe(64);
		expect(unknown.stderr).toContain("未知选项");
	});
});
