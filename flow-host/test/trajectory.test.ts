import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeTrajectoryRecorder } from "../src/executor-adapters/local-pi/trajectory.ts";

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
		const entry = (id: string, parentId: string | null) => ({
			type: "message" as const, id, parentId, timestamp: new Date(0).toISOString(),
			message: { role: "user" as const, content: id, timestamp: 0 },
		});
		const entries = [entry("old", null)];
		const recorder = new NodeTrajectoryRecorder({
			dir,
			source: { getEntries: () => entries },
			start: { executionId: "visit-1", cwd: "/work", model: "fixture" },
		});
		await recorder.start();
		entries.push(entry("a", "old"), entry("b", "a"));
		await recorder.flush();
		// 重复 flush 不重复写入；后续条目继续追加。
		await recorder.flush();
		entries.push(entry("c", "b"));
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
});
