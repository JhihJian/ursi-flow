import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { Catalog, id, optional, readJson, save } from "./catalog.ts";
import { validateVariables } from "../core/contracts/variables.ts";
import { BusinessError, invalid } from "./errors.ts";
import type { PiProviderConfig } from "../executor-adapters/local-pi/sdk.ts";

export interface Config {
	executor: "local-pi";
	provider: PiProviderConfig;
	maxConcurrent: number;
	/** 工作区根目录；启动运行没有指定工作目录时，在其下按 Run ID 新建目录。 */
	workspace: string;
}
/** 记录与接口里的配置：密钥只保留“是否已配置”，不写入 job.json，也不回传给页面。 */
export interface PublicConfig {
	executor: "local-pi";
	provider: Omit<PiProviderConfig, "apiKey"> & { apiKeySet: boolean };
	maxConcurrent: number;
	workspace: string;
}
export function publicConfig(config: Config): PublicConfig {
	const { apiKey, ...provider } = config.provider;
	return {
		executor: config.executor,
		provider: { ...provider, apiKeySet: Boolean(apiKey) },
		maxConcurrent: config.maxConcurrent,
		workspace: config.workspace,
	};
}
/** 轨迹超过这个大小就不整体返回，避免桥接层的响应上限变成 502。 */
const TRAJECTORY_LIMIT = 8 * 1024 * 1024;
interface Job {
	id: string;
	flow: string;
	revision: string;
	cwd: string;
	variables: Record<string, unknown>;
	config: PublicConfig;
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
/** 校验并规范化调用方指定的工作目录。 */
async function existingDirectory(cwd: string) {
	if (cwd.includes("\0")) throw invalid("工作目录无效");
	try {
		const resolved = await realpath(cwd);
		if (!(await stat(resolved)).isDirectory()) throw invalid("需要工作目录");
		return resolved;
	} catch (e) {
		if (["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? ""))
			throw invalid("工作目录不可用");
		throw e;
	}
}
/** 没有指定工作目录时，在工作区根目录下按 Run ID 新建；Run ID 已通过标识校验，可直接作目录名。 */
async function allocateWorkdir(workspace: string, key: string) {
	if (!workspace)
		throw invalid(
			"没有指定工作目录，且运行配置未设置工作区根目录。请在运行配置里填写工作区根目录，或为这次运行指定已有目录",
		);
	const dir = join(workspace, key);
	try {
		await mkdir(dir, { recursive: true });
		return await realpath(dir);
	} catch (e) {
		if (["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EROFS"].includes((e as NodeJS.ErrnoException).code ?? ""))
			throw invalid(`工作区根目录不可用：${workspace}`);
		throw e;
	}
}
/** 同一个 Run ID 只有在 Flow、工作目录、变量与修订都一致时才能复用。 */
function sameRequest(
	previous: Job,
	flow: string,
	cwd: string,
	variables: Record<string, unknown>,
	expectedRevision?: string,
) {
	return (
		(expectedRevision === undefined || previous.revision === expectedRevision) &&
		previous.flow === flow &&
		previous.cwd === cwd &&
		isDeepStrictEqual(previous.variables, variables)
	);
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
		return join(this.catalog.home, "runs", key);
	}
	async list() {
		const ids = await optional(readdir(join(this.catalog.home, "runs")), []);
		return Promise.all(ids.map((x) => this.readJob(x)));
	}
	private async readJob(key: string): Promise<Job> {
		const job: Job = await readJson(join(this.dir(key), "job.json"));
		if (job?.id !== key || typeof job.status !== "string") throw Error("已保存的 Run 无效");
		if (job.status === "running" && !this.active.has(key))
			job.status = "unknown";
		return job;
	}
	private async find(key: string) {
		const exists = await optional(stat(this.dir(id(key))), null);
		return exists ? this.readJob(key) : null;
	}
	async get(key: string) {
		const job = await this.find(key);
		if (!job) throw new BusinessError("not_found", "Run 不存在");
		return job;
	}
	async history(key: string) {
		const job = await this.get(key);
		return {
			job,
			// 历史信封始终携带全部事实集合，消费方不必区分“尚未提交”和“没有记录”。
			...(await optional(readJson(join(this.dir(key), "facts.json")), {
				runs: [],
				nodeRuns: [],
				routeDecisions: [],
				parallelRounds: [],
				recoveries: [],
			})),
		};
	}
	/** 运行使用的目录修订；Flow 之后被删除或改动也不影响这里读到的包。 */
	async flow(key: string) {
		const job = await this.get(key);
		return this.catalog.at(job.flow, job.revision);
	}
	/** 一次 Agent 节点执行的 Pi 会话轨迹切片；命令节点没有轨迹文件。 */
	async trajectory(key: string, node: string) {
		await this.get(key);
		const file = join(this.dir(key), "trajectories", `${id(node)}.jsonl`);
		const info = await optional(stat(file), null);
		if (!info) throw new BusinessError("not_found", "该节点还没有会话轨迹");
		if (info.size > TRAJECTORY_LIMIT)
			return { node, size: info.size, jsonl: "", omitted: true };
		return { node, size: info.size, jsonl: await readFile(file, "utf8") };
	}
	async start(
		key: string,
		flow: string,
		cwd: string | undefined,
		variables: Record<string, unknown>,
		readConfig: () => Promise<Config>,
		expectedRevision?: string,
	) {
		id(key);
		id(flow);
		try {
			validateVariables(variables);
		} catch (e) {
			if (e instanceof Error && e.constructor === Error) throw invalid(e.message);
			throw e;
		}
		// 显式工作目录先校验；不指定时按配置的工作区在 <workspace>/<Run ID> 新建。
		const explicit = typeof cwd === "string" && Boolean(cwd.trim());
		if (!explicit && cwd !== undefined && cwd !== "")
			throw invalid("工作目录无效");
		const previous = await this.find(key);
		let workdir = explicit ? await existingDirectory(cwd as string) : undefined;
		// 复用 Run ID 的判断不需要读取配置，显式目录的重复请求在这里就能返回。
		if (previous && workdir && sameRequest(previous, flow, workdir, variables, expectedRevision))
			return previous;
		const config = await readConfig();
		if (!workdir) workdir = await allocateWorkdir(config.workspace, key);
		if (previous) {
			if (!sameRequest(previous, flow, workdir, variables, expectedRevision))
				throw new BusinessError("conflict", "Run ID 冲突");
			return previous;
		}
		// Catalog publication and registration share the daemon request queue. A stale
		// pin conflicts even at capacity; ordinary starts retain their busy-first check.
		const pinned = expectedRevision === undefined
			? undefined
			: await this.catalog.get(flow, expectedRevision);
		if (this.active.size >= config.maxConcurrent)
			throw new BusinessError("busy", "达到运行并发上限");
		const { revision } = pinned ?? (await this.catalog.get(flow));
		const dir = this.dir(key);
		await mkdir(dir, { recursive: true });
		const job: Job = {
			id: key,
			flow,
			revision,
			cwd: workdir,
			variables,
			config: publicConfig(config),
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
		// provider 只经进程间消息交给 worker，避免密钥进入已落盘的 job.json。
		child.send(
			{ job, provider: config.provider, path: join(this.catalog.root(revision), flow), dir },
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
