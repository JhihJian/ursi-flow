#!/usr/bin/env node
import { createServer } from "node:net";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Catalog, optional, readJson, save } from "./catalog.ts";
import { Runs, publicConfig, type Config } from "./runs.ts";
import { PROVIDER_APIS, THINKING_LEVELS } from "../executor-adapters/local-pi/sdk.ts";
import { isRecord } from "../core/contracts/variables.ts";
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
		!Object.keys(c).every((k) => ["executor", "provider", "maxConcurrent"].includes(k)) ||
		c.executor !== "local-pi" ||
		!isRecord(c.provider) ||
		typeof c.maxConcurrent !== "number" ||
		!Number.isInteger(c.maxConcurrent) ||
		c.maxConcurrent < 1 ||
		c.maxConcurrent > 64
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
async function config(): Promise<Config> {
	const c = await optional(readJson(configFile), {
		executor: "local-pi",
		provider: { baseUrl: "", apiKey: "", model: "" },
		maxConcurrent: 4,
	});
	if (!validConfig(c)) throw Error("已保存的配置无效");
	return c;
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
			const next = {
				...current,
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
				a.id, a.flow, a.cwd,
				a.variables === undefined ? {} : a.variables,
				async () => {
					const c = await config();
					requireProvider(c);
					return c;
				},
				op === "run.startPinned" ? a.revision : undefined,
			);
		case "run.stop":
			return runs.stop(a.id);
		case "run.get":
			return runs.get(a.id);
		case "run.history":
			return runs.history(a.id);
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
server.listen(join(home, "runtime.sock"), () => {
	if (process.env.URSI_FLOWD_NOTIFY === "1") process.stdout.write("ready-v1\n");
});
for (const signal of ["SIGTERM", "SIGINT"])
	process.once(signal, () => {
		server.close(async () => {
			await queue;
			await Promise.all([...runs.active.keys()].map((key) => runs.stop(key)));
			process.exit(0);
		});
	});
