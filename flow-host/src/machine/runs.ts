import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { Catalog, id, optional, readJson, save } from "./catalog.ts";
import { validateVariables } from "ursi-flow-core/runtime";
import { BusinessError, invalid } from "./errors.ts";
import { FileLogStore } from "ursi-flow-runtime";
import { PlatformClient, parseExecutorRef, platformConfig, type ExecutorRef, type PlatformConfig } from "../executor-adapters/platform.ts";
import { PlatformExecutor } from "../runtime/platform-executor.ts";
import { projectHistory } from "./history.ts";
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
	executorRef?: ExecutorRef;
	platformOrigin?: string;
	stopRequested?: boolean;
	id: string;
	flow: string;
	revision: string;
	cwd: string;
	variables: Record<string, unknown>;
}
export type JobView = Job & { status: string; error?: string };
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
	executorRef?: ExecutorRef,
) {
	return (
		(expectedRevision === undefined || previous.revision === expectedRevision) &&
		isDeepStrictEqual(previous.executorRef, executorRef) &&
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
	private readonly store: FileLogStore;

	constructor(catalog: Catalog) {
		this.catalog = catalog;
		this.store = new FileLogStore(catalog.home);
	}
	dir(key: string) {
		return join(this.catalog.home, "runs", key);
	}
	/** 运行状态由日志快照推导；job.json 只保存受理意图。 */
	private async view(key: string, job: Job): Promise<JobView> {
		const stored = await this.store.load(key).catch(() => undefined);
		const status = this.active.has(key)
			? "running"
			: stored?.snapshot.status === "completed"
				? "completed"
				: stored?.snapshot.status === "failed"
					? "failed"
					: stored?.snapshot.status === "awaiting_input"
						? job.stopRequested
							? "stopped"
							: "waiting_input"
						: stored?.snapshot.status === "unconfirmed"
							? "unknown"
							: job.stopRequested
								? "stopped"
								: "unknown";
		const failure = stored?.snapshot.failure;
		return {
			...job,
			status,
			...(failure === undefined ? {} : { error: failure.message }),
		};
	}
	async list() {
		const ids = await optional(readdir(join(this.catalog.home, "runs")), []);
		return Promise.all(ids.map((key) => this.readJob(key)));
	}
	private async readJob(key: string): Promise<JobView> {
		id(key);
		const job: Job = await readJson(join(this.dir(key), "job.json"));
		if (job?.id !== key || typeof job.flow !== "string") throw Error("已保存的 Run 无效");
		return this.view(key, job);
	}
	private async find(key: string) {
		const exists = await optional(stat(this.dir(id(key))), null);
		return exists
			? ((await readJson(join(this.dir(key), "job.json"))) as Job)
			: null;
	}
	async get(key: string): Promise<JobView> {
		const job = await this.find(key);
		if (!job) throw new BusinessError("not_found", "Run 不存在");
		return this.view(key, job);
	}
	async history(key: string) {
		const job = await this.get(key);
		const stored = await this.store.load(key);
		if (!stored) throw new BusinessError("not_found", "Run 不存在");
		const attempts = await new PlatformExecutor(
			{ origin: "http://127.0.0.1", token: "unused" },
			{ id: "unused", revision: 1 },
			this.dir(key),
		)
			.attempts()
			.catch(() => ({}));
		const projection = projectHistory(
			stored.header,
			stored.snapshot,
			stored.events,
			attempts,
		);
		return {
			job,
			runs: projection.runs,
			nodeRuns: projection.nodeRuns,
			routeDecisions: projection.routeDecisions,
			parallelRounds: projection.parallelRounds,
			recoveries: projection.recoveries,
		};
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
		executorRef?: ExecutorRef,
	): Promise<JobView> {
		id(key);
		id(flow);
		try {
			if (executorRef !== undefined) executorRef = parseExecutorRef(executorRef);
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
		if (previous && workdir) {
			if (sameRequest(previous, flow, workdir, variables, expectedRevision, executorRef))
				return this.view(key, previous);
			throw new BusinessError("conflict", "Run ID 冲突");
		}
		const config = await readConfig();
		if (!workdir) workdir = await allocateWorkdir(config.workspace, key);
		if (previous) {
			if (!sameRequest(previous, flow, workdir, variables, expectedRevision, executorRef))
				throw new BusinessError("conflict", "Run ID 冲突");
			return this.view(key, previous);
		}
		// Catalog publication and registration share the daemon request queue. A stale
		// pin conflicts even at capacity; ordinary starts retain their busy-first check.
		const pinned = expectedRevision === undefined
			? undefined
			: await this.catalog.get(flow, expectedRevision);
		if (this.active.size >= config.maxConcurrent)
			throw new BusinessError("busy", "达到运行并发上限");
		const { revision } = pinned ?? (await this.catalog.get(flow));
		let platform: PlatformConfig | undefined;
		if (executorRef) {
			try {
				platform = platformConfig();
				await new PlatformClient(platform).checkNodeExecutor(executorRef);
			} catch (e) {
				throw invalid(e instanceof Error ? e.message : "无效的平台配置");
			}
		}
		const dir = this.dir(key);
		await mkdir(dir, { recursive: true });
		const job: Job = {
			id: key,
			...(executorRef && platform
				? { executorRef, platformOrigin: platform.origin }
				: {}),
			flow,
			revision,
			cwd: workdir,
			variables,
		};
		return this.launch(job, config, platform, false);
	}
	private async launch(
		job: Job,
		config: Config,
		platform: PlatformConfig | undefined,
		resume: boolean,
		respond?: { stepId: string; result: string },
	): Promise<JobView> {
		const { id: key, flow, revision } = job;
		const dir = this.dir(key),
			file = join(dir, "job.json");
		await save(file, job);
		const env = { ...process.env };
		delete env.URSI_EXECUTOR_PLATFORM_TOKEN;
		const child = fork(
			fileURLToPath(new URL("./worker.js", import.meta.url)),
			[],
			{ env, detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
		);
		let error: string | undefined;
		child.on("message", (msg: unknown) => {
			if (typeof msg === "string" && msg !== "awaiting" && msg !== "unconfirmed")
				error = msg.slice(0, 2000);
		});
		const info = { pid: child.pid ?? 0, stop: false, done: Promise.resolve() };
		this.active.set(key, info);
		info.done = new Promise<void>((resolve) => {
			child.once("error", (e) => {
				error = e.message;
			});
			child.once("close", async () => {
				try {
					if (error) {
						const view = await this.view(key, job);
						if (view.status !== "failed" && view.status !== "completed")
							console.error("运行未正常结束", key, error);
					}
				} finally {
					this.active.delete(key);
					resolve();
				}
			});
		});
		// provider 只经进程间消息交给 worker，避免密钥进入已落盘的 job.json。
		child.send(
			{
				path: join(this.catalog.root(revision), flow, "FLOW.md"),
				dir,
				store: this.catalog.home,
				job,
				resume,
				respond,
				platform,
				provider: platform ? undefined : config.provider,
			},
			(err) => {
				if (err) error = err.message;
			},
		);
		return this.view(key, job);
	}
	private boundPlatform(job: Job) {
		const platform = platformConfig();
		if (platform.origin !== job.platformOrigin)
			throw invalid("平台地址与原 Run 不一致");
		return platform;
	}
	async resume(key: string, readConfig: () => Promise<Config>): Promise<JobView> {
		const job = await this.find(key);
		if (!job) throw new BusinessError("not_found", "Run 不存在");
		if (this.active.has(key)) return this.view(key, job);
		const stored = await this.store.load(key);
		const status = stored?.snapshot.status;
		if (status !== "awaiting_input" && status !== "unconfirmed" && status !== "running")
			throw invalid("只能恢复未完成的运行");
		if (job.executorRef && job.stopRequested)
			throw invalid("已请求停止的运行不能恢复");
		const config = await readConfig();
		if (this.active.size >= config.maxConcurrent)
			throw new BusinessError("busy", "达到运行并发上限");
		return this.launch(
			job,
			config,
			job.executorRef ? this.boundPlatform(job) : undefined,
			true,
		);
	}
	/** 人工应答：校验等待状态与节点匹配后，以应答模式重启 worker。 */
	async respond(
		key: string,
		nodeRunId: string,
		result: string,
		readConfig: () => Promise<Config>,
	): Promise<JobView> {
		const job = await this.find(key);
		if (!job) throw new BusinessError("not_found", "Run 不存在");
		if (this.active.has(key)) return this.view(key, job);
		const stored = await this.store.load(key);
		const pending = stored?.snapshot.pending;
		if (
			!stored ||
			stored.snapshot.status !== "awaiting_input" ||
			!pending ||
			job.stopRequested
		)
			throw invalid("只能应答等待人工确认的 Run");
		if (job.executorRef) throw invalid("平台 Run 不支持人工确认门禁");
		if (typeof nodeRunId !== "string" || !nodeRunId || typeof result !== "string" || !result)
			throw invalid("应答需要 nodeRunId 与 result");
		if (pending.stepId !== nodeRunId) throw invalid("节点不在等待人工确认");
		if (!pending.options.includes(result))
			throw invalid(
				`无效的确认结果“${result}”，可选：${pending.options.join("、")}`,
			);
		const config = await readConfig();
		if (this.active.size >= config.maxConcurrent)
			throw new BusinessError("busy", "达到运行并发上限");
		return this.launch(job, config, undefined, false, { stepId: nodeRunId, result });
	}
	async stop(key: string): Promise<JobView> {
		const job = await this.find(key);
		if (!job) throw new BusinessError("not_found", "Run 不存在");
		const info = this.active.get(key);
		if (job.executorRef) {
			job.stopRequested = true;
			await save(join(this.dir(key), "job.json"), job);
		}
		if (info?.pid) {
			info.stop = true;
			try {
				process.kill(-info.pid, "SIGKILL");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
			}
			await info.done;
		} else if (!job.executorRef) {
			// 本地运行没有活动 worker 时，停止只记取消意图并压住后续应答。
			job.stopRequested = true;
			await save(join(this.dir(key), "job.json"), job);
		}
		if (job.executorRef) {
			try {
				const platform = this.boundPlatform(job);
				const executor = new PlatformExecutor(platform, job.executorRef, this.dir(key));
				const confirmed = await executor.cancel();
				const stopped = info ? await groupStopped(info.pid) : true;
				if (!stopped || !confirmed) {
					job.stopRequested = true;
					await save(join(this.dir(key), "job.json"), job);
				}
			} catch {
				job.stopRequested = true;
				await save(join(this.dir(key), "job.json"), job);
			}
		}
		return this.view(key, job);
	}
	async shutdown(key: string) {
		const info = this.active.get(key);
		if (!info) return;
		const job = await this.find(key);
		if (job?.executorRef) return this.stop(key);
		info.stop = true;
		try {
			process.kill(-info.pid, "SIGKILL");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
		}
		await info.done;
	}
}
