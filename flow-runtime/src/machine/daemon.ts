#!/usr/bin/env node
import { createServer } from "node:net";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Catalog, optional, readJson, save } from "./catalog.ts";
import { Runs, type Config } from "./runs.ts";

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
const config = (): Promise<Config> =>
	optional(readJson(configFile), {
		executor: "local-pi",
		maxConcurrent: 4,
		model: "",
	});
async function dispatch({
	v,
	op,
	args: a,
}: {
	v: number;
	op: string;
	args: Record<string, any>;
}) {
	if (v !== 1 || !a || typeof a !== "object") throw Error("无效协议请求");
	switch (op) {
		case "config.get":
			return config();
		case "config.update": {
			const c = { ...(await config()), ...a };
			if (
				Object.keys(c).some(
					(k) => !["executor", "model", "maxConcurrent"].includes(k),
				) ||
				c.executor !== "local-pi" ||
				typeof c.model !== "string" ||
				!Number.isInteger(c.maxConcurrent) ||
				c.maxConcurrent < 1 ||
				c.maxConcurrent > 64
			)
				throw Error("配置无效");
			await save(configFile, c);
			return c;
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
			return runs.start(a.id, a.flow, a.cwd, a.variables ?? {}, await config());
		case "run.stop":
			return runs.stop(a.id);
		case "run.get":
			return runs.get(a.id);
		case "run.history":
			return runs.history(a.id);
		case "run.list":
			return runs.list();
		default:
			throw Error("未知操作");
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
		if (size > 4 * 1024 * 1024) socket.destroy();
		else chunks.push(chunk);
	});
	socket.on("end", () => {
		queue = queue
			.then(async () => {
				if (size > 4 * 1024 * 1024 || socket.destroyed) return;
				try {
					const data = await dispatch(
						JSON.parse(Buffer.concat(chunks).toString("utf8")),
					);
					socket.end(JSON.stringify({ v: 1, data }) + "\n");
				} catch (e) {
					socket.end(
						JSON.stringify({
							v: 1,
							error: e instanceof Error ? e.message : String(e),
						}) + "\n",
					);
				}
			})
			.catch((e) => console.error(e));
	});
});
server.listen(join(home, "runtime.sock"));
for (const signal of ["SIGTERM", "SIGINT"])
	process.once(signal, () => {
		server.close(async () => {
			await queue;
			await Promise.all([...runs.active.keys()].map((key) => runs.stop(key)));
			process.exit(0);
		});
	});
