import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeTrajectoryRecorder } from "../src/executor-adapters/local-pi/trajectory.ts";
import { Catalog } from "../src/machine/catalog.ts";

const dirs: string[] = [];
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "ursi-trajectory-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("节点会话轨迹", () => {
	it("按节点执行切分条目并保留原始父子关系", async () => {
		const dir = await tempDir();
		const entries = [
			{ type: "message", id: "old", parentId: null, message: { role: "user" } },
		];
		const recorder = new NodeTrajectoryRecorder({
			dir,
			source: { getEntries: () => entries },
			start: { executionId: "visit-1", cwd: "/work", model: "fixture" },
		});
		await recorder.start();
		entries.push(
			{ type: "message", id: "a", parentId: "old", message: { role: "user" } },
			{ type: "message", id: "b", parentId: "a", message: { role: "assistant" } },
		);
		await recorder.flush();
		// 重复 flush 不重复写入；后续条目继续追加。
		await recorder.flush();
		entries.push({ type: "message", id: "c", parentId: "b", message: { role: "user" } });
		await recorder.stop();
		const lines = (await readFile(join(dir, "visit-1.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({
			type: "session",
			id: "visit-1",
			cwd: "/work",
			modelId: "fixture",
		});
		expect(lines.slice(1).map((line) => line.id)).toEqual(["a", "b", "c"]);
		expect(lines[2].parentId).toBe("a");
	});

	it("只读取运行修订的包，不回落当前目录", async () => {
		const home = await tempDir();
		const revision = "11111111-1111-4111-8111-111111111111";
		const pkg = join(home, "versions", revision, "ordinary");
		await mkdir(pkg, { recursive: true });
		await writeFile(join(pkg, "FLOW.md"), "flowchart TD\n");
		const catalog = new Catalog(home);
		expect((await catalog.at("ordinary", revision)).files["FLOW.md"]).toContain(
			"flowchart TD",
		);
		await expect(
			catalog.at("ordinary", "22222222-2222-4222-8222-222222222222"),
		).rejects.toThrow("修订");
	});
});

describe("Flow 列表元信息", () => {
	it("一次返回名称、说明与规模，坏包只带原因", async () => {
		const home = await tempDir();
		const catalog = new Catalog(home);
		await catalog.change("create", "release", {
			"FLOW.md": `---\nname: 发布检查\ndescription: 校验版本号后发布。\n---\n\n\`\`\`mermaid\nflowchart TD\n  start((开始)) --> work[执行]\n  work -->|已完成| finish((结束))\n\`\`\`\n\n## 执行\n\n\`\`\`新建Agent\n校验版本号。\n\`\`\`\n\n### 已完成\n\n完成。\n`,
		});
		// 目录里的历史修订可能留有解析不了的包，列表不能因此整页失败。
		const revision = await catalog.current();
		const broken = join(home, "versions", revision!, "broken");
		await mkdir(broken, { recursive: true });
		await writeFile(
			join(broken, "FLOW.md"),
			"---\nname: 坏包\ndescription: 缺图。\n---\n\n# 没有图\n",
		);
		const list = await catalog.summaries();
		expect(list.map((item) => item.id)).toEqual(["broken", "release"]);
		expect(list.find((item) => item.id === "release")).toMatchObject({
			name: "发布检查",
			description: "校验版本号后发布。",
			// 开始与结束节点不计入业务节点。
			nodes: 1,
			variables: 0,
		});
		expect(list.find((item) => item.id === "broken")).toMatchObject({
			id: "broken",
			error: expect.stringContaining("Mermaid"),
		});
	});
});
