#!/usr/bin/env node
import { connect, createServer } from "node:net";
import { lstat, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Catalog, optional, readJson, save } from "./catalog.ts";
import { Runs, publicConfig, type Config } from "./runs.ts";
import { PROVIDER_APIS, THINKING_LEVELS } from "../executor-adapters/local-pi/sdk.ts";
import { isRecord } from "ursi-flow-core/runtime";
import { BusinessError, invalid } from "./errors.ts";

process.umask(0o077);
const home = resolve(
	process.env.URSI_FLOW_HOME ?? join(homedir(), ".ursi-flow"),
);
await mkdir(home, { mode: 0o700, recursive: true });
const st = await lstat(home);
if (!st.isDirectory() || st.uid !== process.getuid?.() || st.mode & 0o077)
	throw Error("Runtime 目录须为本人拥有的私有目录 (0700)");
const catalog = new Catalog(home),
	runs = new Runs(catalog);
const configFile = join(home, "config.json");
/** 允许 provider 只填了一部分：保存未完成的配置，运行时再报缺哪一项。 */
function validConfig(c: unknown): c is Config {
	if (
		!isRecord(c) ||
		!Object.keys(c).every((k) => ["executor", "provider", "maxConcurrent", "workspace"].includes(k)) ||
		c.executor !== "local-pi" ||
		!isRecord(c.provider) ||
		typeof c.maxConcurrent !== "number" ||
		!Number.isInteger(c.maxConcurrent) ||
		c.maxConcurrent < 1 ||
		c.maxConcurrent > 64 ||
		typeof c.workspace !== "string"
	)
		return false;
	const p = c.provider as Record<string, unknown>;
	if (!Object.keys(p).every((k) => PROVIDER_FIELDS.includes(k))) return false;
	for (const key of ["baseUrl", "apiKey", "model"] as const)
		if (typeof p[key] !== "string") return false;
	if (p.api !== undefined && !PROVIDER_APIS.includes(p.api as never)) return false;
	if (
		p.thinkingLevel !== undefined &&
		!THINKING_LEVELS.includes(p.thinkingLevel as never)
	)
		return false;
	for (const key of ["contextWindow", "maxTokens"] as const) {
		const value = p[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
			return false;
	}
	return p.reasoning === undefined || typeof p.reasoning === "boolean";
}
const PROVIDER_FIELDS = [
	"baseUrl", "apiKey", "model", "api", "contextWindow", "maxTokens", "reasoning", "thinkingLevel",
];
const defaultConfig = (): Config => ({
	executor: "local-pi",
	provider: { baseUrl: "", apiKey: "", model: "" },
	maxConcurrent: 4,
	workspace: "",
});
/** 早期配置没有 workspace 字段，读出来补成空串，运行时再提示去填。 */
async function config(): Promise<Config> {
	const saved = await optional(readJson(configFile), {});
	const merged = {
		...defaultConfig(),
		...(isRecord(saved) ? saved : {}),
		provider: {
			...defaultConfig().provider,
			...(isRecord(saved) && isRecord(saved.provider) ? saved.provider : {}),
		},
	};
	if (!validConfig(merged)) throw Error("已保存的配置无效");
	return merged;
}
/** 工作区根目录必须是绝对路径；改成新目录时先建出来，启动运行才有地方放工作目录。 */
async function workspaceOf(value: unknown, current: string) {
	if (value === undefined || value === null) return current;
	if (typeof value !== "string") throw invalid("工作区根目录必须是字符串");
	const workspace = value.trim();
	if (!workspace) return "";
	if (workspace.includes("\0") || !isAbsolute(workspace))
		throw invalid("工作区根目录必须是绝对路径");
	try {
		await mkdir(workspace, { recursive: true, mode: 0o700 });
	} catch {
		throw invalid(`工作区根目录不可用：${workspace}`);
	}
	return workspace;
}
/** provider 没配全就不启动运行，错误里指出缺哪一项。 */
function requireProvider(c: Config): void {
	const missing = (["baseUrl", "apiKey", "model"] as const).filter(
		(key) => !c.provider[key]?.trim(),
	);
	if (missing.length)
		throw invalid(
			`模型 provider 未配置：缺少 provider.${missing.join("、provider.")}。请在运行配置里填写模型服务地址、密钥与模型标识`,
		);
}
async function dispatch(request: unknown) {
	if (!isRecord(request) || request.v !== 1 || !isRecord(request.args))
		throw invalid("无效协议请求");
	const { op } = request;
	const a: Record<string, any> = request.args;
	switch (op) {
		case "config.get":
			return publicConfig(await config());
		case "config.update": {
			const current = await config();
			const workspace = await workspaceOf(a.workspace, current.workspace);
			const next = {
				...current,
				workspace,
				...(typeof a.maxConcurrent === "number" ? { maxConcurrent: a.maxConcurrent } : {}),
				...(isRecord(a.provider)
					? {
							provider: {
								...current.provider,
								...a.provider,
								// 空密钥表示沿用已保存的密钥，避免页面每次保存都要回填。
								...(a.provider.apiKey ? {} : { apiKey: current.provider.apiKey }),
							},
						}
					: {}),
			};
			if (!validConfig(next)) throw invalid("配置无效");
			await save(configFile, next);
			return publicConfig(next);
		}
		case "flow.validate":
		case "flow.create":
		case "flow.update":
		case "flow.delete":
			return catalog.change(op.slice(5), a.id, a.files, a.expectedRevision);
		case "flow.list":
			return catalog.list();
		case "flow.get":
			return catalog.get(a.id);
		case "run.start":
		case "run.startPinned":
			if (op === "run.startPinned" && (typeof a.revision !== "string" || !a.revision))
				throw invalid("需要目录修订");
			return runs.start(
				a.id, a.flow,
				typeof a.cwd === "string" && a.cwd ? a.cwd : undefined,
				a.variables === undefined ? {} : a.variables,
				async () => {
					const c = await config();
					if (a.executorRef === undefined) requireProvider(c);
					return c;
				},
				op === "run.startPinned" ? a.revision : undefined,
				a.executorRef,
			);
		case "run.resume":
			return runs.resume(a.id, config);
		case "run.respond":
			return runs.respond(a.id, a.nodeRunId, a.result, config);
		case "run.stop":
			return runs.stop(a.id);
		case "run.get":
			return runs.get(a.id);
		case "run.history":
			return runs.history(a.id);
		case "run.trajectory":
			return runs.trajectory(a.id, a.node);
		case "run.list":
			return runs.list();
		default:
			throw invalid("未知操作");
	}
}
let queue = Promise.resolve();
const server = createServer({ allowHalfOpen: true }, (socket) => {
	const chunks: Buffer[] = [];
	let size = 0;
	socket.setTimeout(30000, () => socket.destroy());
	socket.on("error", () => socket.destroy());
	socket.on("data", (chunk) => {
		size += chunk.length;
		if (size <= 4 * 1024 * 1024) chunks.push(chunk);
	});
	socket.on("end", () => {
		socket.setTimeout(0);
		queue = queue
			.then(async () => {
				if (socket.destroyed) return;
				try {
					if (size > 4 * 1024 * 1024) throw invalid("请求过大");
					let request: unknown;
					try {
						request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					} catch (e) {
						if (e instanceof SyntaxError) throw invalid("请求不是有效 JSON");
						throw e;
					}
					const data = await dispatch(request);
					socket.end(JSON.stringify({ v: 1, data }) + "\n");
				} catch (e) {
					socket.end(
						JSON.stringify({
							v: 1,
							error: e instanceof Error ? e.message : String(e),
							code: e instanceof BusinessError ? e.code : undefined,
						}) + "\n",
					);
				}
			})
			.catch((e) => console.error(e));
	});
});
const socketFile = join(home, "runtime.sock");
// 断电等异常退出会留下没人监听的 socket 文件。先探活：连得上说明已有 daemon 在跑（保留文件，交给 listen 报占用），连不上才清理。
const stale = await lstat(socketFile)
	.then(
		() =>
			new Promise<boolean>((resolve) => {
				const probe = connect(socketFile);
				probe.once("connect", () => {
					probe.destroy();
					resolve(false);
				});
				probe.once("error", () => resolve(true));
			}),
		() => false,
	)
	.catch(() => false);
if (stale) await rm(socketFile);
server.listen(socketFile, () => {
	if (process.env.URSI_FLOWD_NOTIFY === "1") process.stdout.write("ready-v1\n");
});
for (const signal of ["SIGTERM", "SIGINT"])
	process.once(signal, () => {
		server.close(async () => {
			await queue;
			await Promise.all([...runs.active.keys()].map((key) => runs.shutdown(key)));
			process.exit(0);
		});
	});
