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
