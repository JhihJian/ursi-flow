import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPACITY, withLedger } from "../src/pi-executor/ledger.ts";
import { layout, parseConfig, policyFile, snapshot } from "../src/pi-executor/files.ts";
import { supervise } from "../src/pi-executor/worker.ts";

const src = new URL("../src/", import.meta.url);
const expire: string[] = [];
afterEach(async () => { await Promise.all(expire.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const config = { systemPrompt: "fixed", modelProfile: "managed", skills: [{ id: "s", revision: 1, content: "context" }], tools: [] };
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "pi-job-"));
	expire.push(dir);
	const root = join(dir, "root"), id = randomUUID(), attempt = join(root, id), workspace = join(attempt, "workspace");
	const policy = join(dir, "policy.json"), path = join(attempt, "agent-config.json");
	await mkdir(join(workspace, "inputs"), { recursive: true, mode: 0o700 });
	await mkdir(join(workspace, "artifacts"), { mode: 0o700 });
	await writeFile(path, JSON.stringify({ ...config, extra: "private metadata" }), { mode: 0o600 });
	await writeFile(policy, "{}", { mode: 0o600 });
	const env = { URSI_EXECUTOR_ROOT: root, URSI_PI_POLICY: policy };
	return { dir, root, id, workspace, attempt, path, policy, env };
}

// Exercise the shipping entry points as separate processes; only the SDK boundary is replaced.
async function host() {
	const f = await fixture();
	await writeFile(join(f.dir, "package.json"), '{"type":"module"}');
	const pi = join(f.dir, "pi-executor");
	await mkdir(pi);
	await cp(new URL("integrations/mcp", src), join(f.dir, "integrations/mcp"), { recursive: true });
	for (const name of ["files", "ledger", "jobs", "worker", "runner", "stdio"]) await copyFile(new URL(`pi-executor/${name}.ts`, src), join(pi, `${name}.ts`));
	await writeFile(join(pi, "session.ts"), `
		import { appendFile } from 'node:fs/promises';
		import { setTimeout } from 'node:timers/promises';
		export async function runPi(config, workspace, instruction, signal) {
			await appendFile(workspace + '/artifacts/prompts', JSON.stringify({config,instruction}) + '\\n');
			if (instruction === 'crash') process.kill(process.pid, 'SIGKILL');
			if (instruction === 'wait') await setTimeout(8000, undefined, {signal});
		}
	`);
	const log = join(f.workspace, "artifacts/prompts");
	async function call(name: string, text?: string, runConfig?: unknown) {
		const args = text === undefined ? { attemptId: f.id } : { attemptId: f.id, workspaceRef: `workspace:${f.id}`, artifactDirectoryRef: `artifacts:${f.id}`, workInstruction: text, runConfig };
		const p = spawn(process.execPath, [join(pi, "stdio.ts")], { env: f.env, stdio: ["pipe", "pipe", "pipe"] });
		const lines = [
			{ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
			{ method: "notifications/initialized" },
			{ id: 2, method: "tools/call", params: { name: `executor_${name}`, arguments: args } },
		];
		p.stdin.end(lines.map(l => JSON.stringify({ jsonrpc: "2.0", ...l }) + "\n").join(""));
		let out = ""; p.stdout.on("data", x => { out += x; });
		let err = ""; p.stderr.on("data", x => { err += x; });
		await new Promise<void>((resolve, reject) => {
			p.on("error", reject); p.on("close", code => code === 0 ? resolve() : reject(new Error(err)));
		});
		const [init, reply] = out.trim().split("\n").map(line => JSON.parse(line));
		expect(init.result.serverInfo.name).toBe("ursi-pi-executor");
		if (reply.result.isError) return JSON.parse(reply.result.content[0].text).code;
		expect(JSON.parse(reply.result.content[0].text)).toEqual(reply.result.structuredContent);
		expect(reply.result.structuredContent.backendRunRef).toBe(`pi:${f.id}`);
		return reply.result.structuredContent.status;
	}
	return { ...f, call, log };
}

describe("Pi lifecycle", () => {
	it("completes one prompt across concurrent MCP starts, lost receipt and retries", async () => {
		const f = await host();
		expect(await f.call("inspect")).toBe("not_found");
		expect(await f.call("cancel")).toBe("not_found");
		expect(await f.call("start", " ")).toBe("invalid");
		expect(await f.call("start", "x".repeat(256 * 1024 + 1))).toBe("invalid");
		const instruction = "review\0the complete instruction";
		expect(await f.call("start", instruction, { modelProfile: "other" })).toBe("invalid");
		expect(await f.call("inspect")).toBe("not_found");
		const replies = await Promise.all(Array.from({length: 5}, () => f.call("start", instruction)));
		expect(replies.every(s => ["succeeded", "running"].includes(s))).toBe(true);
		await expect.poll(() => f.call("inspect"), {timeout: 5000}).toBe("succeeded");
		expect(await f.call("cancel")).toBe("succeeded");
		expect(await f.call("start", instruction, {})).toBe("succeeded");
		expect(await f.call("start", "other")).toBe("conflict");
		await writeFile(f.path, JSON.stringify({ ...config, systemPrompt: "changed" }));
		expect(await f.call("start", instruction)).toBe("conflict");
		expect(await readFile(f.log, "utf8")).toBe(JSON.stringify({config, instruction}) + "\n");
	}, 15000);

	it("waits for the session to acknowledge cancellation", async () => {
		const f = await host();
		expect(await f.call("start", "wait")).toBe("running");
		await expect.poll(() => readFile(f.log, "utf8").catch(() => ""), {timeout: 5000}).toContain("wait");
		expect(await f.call("cancel")).toBe("running");
		await expect.poll(() => f.call("inspect"), {timeout: 5000}).toBe("cancelled");
		expect(await f.call("start", "wait")).toBe("cancelled");
	}, 12000);

	it("a crash after prompt delivery stays unverified on retry and cancel", async () => {
		const f = await host();
		await f.call("start", "crash");
		await expect.poll(() => f.call("inspect"), {timeout: 5000}).toBe("unverified");
		expect(await f.call("start", "crash")).toBe("unverified");
		expect(await f.call("cancel")).toBe("unverified");
		expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(1);
	}, 12000);

	it("reserves capacity transactionally and never reclaims an expired attempt", async () => {
		const f = await fixture();
		for (let n = 0; n < CAPACITY; n++) withLedger(f.root, l => l.reserve(String(n), "dir", "digest", "hash", "text"));
		expect(() => withLedger(f.root, l => l.reserve("extra", "dir", "digest", "hash", "text"))).toThrow("busy");
		withLedger(f.root, l => { l.cancel("0"); expect(l.claim("0", "dir")).toBeUndefined(); });
		withLedger(f.root, l => l.reserve("extra", "dir", "digest", "hash", "text"));
		expect(() => withLedger(f.root, l => l.current("extra", "different workspace"))).toThrow("conflict");
		expect(withLedger(f.root, l => l.current("0", "dir").phase)).toBe("cancelled");
		const db = new DatabaseSync(join(f.root, ".pi-jobs.sqlite"));
		try { // A reused PID is not evidence of a live worker, even if it belongs to this test.
			db.prepare("UPDATE jobs SET phase='running',pid=?,owner='old-boot:ticks' WHERE id='extra'").run(process.pid);
		} finally { db.close(); }
		expect(withLedger(f.root, l => l.current("extra", "dir").phase)).toBe("unverified");
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20000);
		try {
			expect(withLedger(f.root, l => l.current("1", "dir").phase)).toBe("unverified");
			expect(withLedger(f.root, l => l.claim("1", "dir"))).toBeUndefined();
		} finally { clock.mockRestore(); }
	});

	it("times out cooperatively or stops an unresponsive thread without claiming completion", async () => {
		const thread = (body: string) => new Worker(`const { parentPort } = require('node:worker_threads'); ${body}`, { eval: true });
		expect(await supervise(thread(`parentPort.on('message', () => parentPort.postMessage('aborted'));`), () => false, 100, 800)).toBe("failed");
		expect(await supervise(thread(`setInterval(() => {}, 10000)`), () => false, 100, 100)).toBe("unverified");
		expect(await supervise(thread(`parentPort.on('message', () => parentPort.postMessage('succeeded'));`), () => true, 2000)).toBe("succeeded");
	});

	it("bounds inputs and excludes links and nonprivate files", async () => {
		const f = await fixture();
		expect(parseConfig({ ...config, command: "/private", extra: true })).toEqual(config);
		expect(() => parseConfig({...config, skills: [config.skills[0], config.skills[0]]})).toThrow();
		expect(() => parseConfig({...config, tools: [{id:"t", schemaDigest:"bad"}]})).toThrow();
		await chmod(f.path, 0o644); expect(() => snapshot(f.attempt)).toThrow();
		await chmod(f.path, 0o600); await link(f.path, join(f.dir, "link")); expect(() => snapshot(f.attempt)).toThrow();
		await rm(f.path); await symlink(join(f.dir, "link"), f.path); expect(() => snapshot(f.attempt)).toThrow();
		expect(() => policyFile({URSI_PI_POLICY:"relative"}, f.root)).toThrow();
		await chmod(f.policy, 0o644); expect(() => policyFile(f.env, f.root)).toThrow();
		await rm(join(f.workspace, "inputs"), {recursive:true}); await symlink(f.dir, join(f.workspace, "inputs"));
		expect(() => layout(f.env, f.id)).toThrow();
	});
});
