import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "../src/machine/catalog.ts";
import { Runs, type Config } from "../src/machine/runs.ts";

const dirs: string[] = [];
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "ursi-runs-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const configWith = (workspace: string): Config => ({
	executor: "local-pi",
	provider: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
	maxConcurrent: 4,
	workspace,
});

const exists = (path: string) =>
	stat(path).then(
		(info) => info.isDirectory(),
		() => false,
	);

describe("运行的工作目录", () => {
	it("未指定目录时在工作区根目录下按 Run ID 新建", async () => {
		const home = await tempDir();
		const workspace = join(home, "workspaces");
		await mkdir(workspace);
		const runs = new Runs(new Catalog(home));
		// 环境里没有这个 Flow，启动会失败，但工作目录在选包之前就已备好。
		await expect(
			runs.start("run-1", "missing", undefined, {}, async () => configWith(workspace)),
		).rejects.toThrow();
		expect(await exists(join(workspace, "run-1"))).toBe(true);
	});

	it("显式指定的目录优先，工作区保持原样", async () => {
		const home = await tempDir();
		const workspace = join(home, "workspaces");
		const project = join(home, "project");
		await mkdir(workspace);
		await mkdir(project);
		const runs = new Runs(new Catalog(home));
		await expect(
			runs.start("run-2", "missing", project, {}, async () => configWith(workspace)),
		).rejects.toThrow();
		expect(await exists(join(workspace, "run-2"))).toBe(false);
	});

	it("没有工作区又没指定目录时说明该去配置哪里", async () => {
		const home = await tempDir();
		const runs = new Runs(new Catalog(home));
		await expect(
			runs.start("run-3", "missing", undefined, {}, async () => configWith("")),
		).rejects.toThrow("工作区根目录");
	});

	it("同一 Run ID 换目录视为冲突，重复请求返回原记录", async () => {
		const home = await tempDir();
		const workspace = join(home, "workspaces");
		await mkdir(workspace);
		const first = join(workspace, "run-4");
		await mkdir(first);
		const other = join(home, "other");
		await mkdir(other);
		const runs = new Runs(new Catalog(home));
		await mkdir(runs.dir("run-4"), { recursive: true });
		await writeFile(
			join(runs.dir("run-4"), "job.json"),
			JSON.stringify({
				id: "run-4",
				flow: "ordinary",
				revision: "rev-1",
				cwd: await realpath(first),
				variables: { 任务: "x" },
				config: { executor: "local-pi", provider: {}, maxConcurrent: 4, workspace },
				status: "failed",
			}),
		);
		await expect(
			runs.start("run-4", "ordinary", other, { 任务: "x" }, async () => configWith(workspace)),
		).rejects.toThrow("冲突");
		const reused = await runs.start(
			"run-4",
			"ordinary",
			first,
			{ 任务: "x" },
			async () => configWith(workspace),
		);
		expect(reused.id).toBe("run-4");
		expect(reused.status).toBe("failed");
	});
});
