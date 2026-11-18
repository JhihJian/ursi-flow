import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { Catalog, id, optional, readJson, save } from "./catalog.ts";

export interface Config {
	executor: "local-pi";
	model: string;
	maxConcurrent: number;
}
interface Job {
	id: string;
	flow: string;
	revision: string;
	cwd: string;
	variables: Record<string, unknown>;
	config: Config;
	status: string;
	error?: string;
}
// A reaped worker is not proof that its command children have stopped. Linux
// may retain zombies until PID 1 reaps them; zombies cannot execute more work.
async function groupStopped(group: number) {
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			process.kill(-group, 0);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
			return false;
		}
		if (process.platform === "linux") {
			let live = false;
			for (const pid of await readdir("/proc")) {
				if (!/^\d+$/.test(pid)) continue;
				const raw = await optional(readFile(`/proc/${pid}/stat`, "utf8"), "");
				const [state, , pgrp] = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
				if (Number(pgrp) === group && state !== "Z" && state !== "X") {
					live = true;
					break;
				}
			}
			if (!live) return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}
export class Runs {
	readonly active = new Map<
		string,
		{ pid: number; done: Promise<void>; stop: boolean }
	>();
	readonly catalog: Catalog;
	constructor(catalog: Catalog) {
		this.catalog = catalog;
	}
	dir(key: string) {
		return join(this.catalog.home, "runs", id(key));
	}
	async list() {
		const ids = await optional(readdir(join(this.catalog.home, "runs")), []);
		return Promise.all(ids.map((x) => this.get(x)));
	}
	async get(key: string): Promise<Job> {
		const job: Job = await readJson(join(this.dir(key), "job.json"));
		if (job.status === "running" && !this.active.has(key))
			job.status = "unknown";
		return job;
	}
	async history(key: string) {
		const job = await this.get(key);
		return {
			job,
			...(await optional(readJson(join(this.dir(key), "facts.json")), {
				runs: [],
				nodeRuns: [],
				routeDecisions: [],
			})),
		};
	}
	async start(
		key: string,
		flow: string,
		cwd: string,
		variables: Record<string, unknown>,
		config: Config,
	) {
		id(key);
		id(flow);
		if (
			typeof cwd !== "string" ||
			!variables ||
			typeof variables !== "object" ||
			Array.isArray(variables)
		)
			throw Error("工作目录或变量无效");
		cwd = await realpath(cwd);
		if (!(await stat(cwd)).isDirectory()) throw Error("需要工作目录");
		const previous = await optional(this.get(key), null);
		if (previous) {
			if (
				previous.flow !== flow ||
				previous.cwd !== cwd ||
				!isDeepStrictEqual(previous.variables, variables)
			)
				throw Error("Run ID 冲突");
			return previous;
		}
		if (this.active.size >= config.maxConcurrent)
			throw Error("达到运行并发上限");
		const { revision } = await this.catalog.get(flow);
		const dir = this.dir(key);
		await mkdir(dir, { recursive: true });
		const job: Job = {
			id: key,
			flow,
			revision,
			cwd,
			variables,
			config,
			status: "running",
		};
		const file = join(dir, "job.json");
		await save(file, job);
		const child = fork(
			fileURLToPath(new URL("./worker.js", import.meta.url)),
			[],
			{ detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
		);
		let error: string | undefined;
		child.on("message", (msg: unknown) => {
			if (typeof msg === "string") error = msg.slice(0, 2000);
		});
		const info = { pid: child.pid ?? 0, stop: false, done: Promise.resolve() };
		this.active.set(key, info);
		info.done = new Promise<void>((resolve) => {
			child.once("error", (e) => {
				error = e.message;
			});
			child.once("close", async (code, signal) => {
				try {
					const facts = await optional(readJson(join(dir, "facts.json")), null);
					const terminal = facts?.runs.find(
						(r: { id: string }) => r.id === key,
					)?.status;
					job.status =
						terminal && terminal !== "running"
							? terminal
							: info.stop && signal === "SIGKILL"
								? (await groupStopped(info.pid))
									? "stopped"
									: "unknown"
								: code === 0
									? "unknown"
									: "failed";
					if (error) job.error = error;
					await save(file, job);
				} catch (e) {
					console.error("无法确认运行终态", key, String(e));
				} finally {
					this.active.delete(key);
					resolve();
				}
			});
		});
		child.send(
			{ job, path: join(this.catalog.root(revision), flow), dir },
			(err) => {
				if (err) error = err.message;
			},
		);
		return job;
	}
	async stop(key: string) {
		const info = this.active.get(id(key));
		if (info?.pid) {
			info.stop = true;
			try {
				process.kill(-info.pid, "SIGKILL");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
			}
			await info.done;
		}
		return this.get(key);
	}
}
