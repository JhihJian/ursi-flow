import {
	cp,
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadFlow } from "../core/definition/flow-loader.ts";

export function id(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][\w-]{0,95}$/.test(value))
		throw Error("非法标识");
	return value;
}
export async function readJson(file: string) {
	return JSON.parse(await readFile(file, "utf8"));
}
export async function save(file: string, value: unknown) {
	const tmp = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
		await rename(tmp, file);
	} finally {
		await rm(tmp, { force: true });
	}
}
export async function optional<T>(op: Promise<T>, fallback: T): Promise<T> {
	try {
		return await op;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw e;
	}
}
export type PackageFiles = Record<string, string>;
export function checkFiles(files: unknown): asserts files is PackageFiles {
	if (
		!files ||
		typeof files !== "object" ||
		Array.isArray(files) ||
		!Object.hasOwn(files, "FLOW.md")
	)
		throw Error("需要包含 FLOW.md 的文件集合");
	for (const [path, text] of Object.entries(files)) {
		if (
			!(
				path === "FLOW.md" ||
				/^(references|scripts)\/(?:[^/\\\x00]+\/)*[^/\\\x00]+$/.test(path)
			) ||
			path.split("/").some((s) => s === "." || s === "..") ||
			typeof text !== "string"
		)
			throw Error("非法包内文件");
	}
}
async function filesAt(dir: string, prefix = ""): Promise<PackageFiles> {
	const files: PackageFiles = {};
	for (const item of await readdir(join(dir, prefix), {
		withFileTypes: true,
	})) {
		const path = prefix + item.name;
		if (item.isDirectory())
			Object.assign(files, await filesAt(dir, path + "/"));
		else if (item.isFile())
			files[path] = await readFile(join(dir, path), "utf8");
		else throw Error("不接受非普通文件");
	}
	return files;
}
export class Catalog {
	readonly home: string;
	constructor(home: string) {
		this.home = home;
	}
	async current(): Promise<string | null> {
		return optional(readJson(join(this.home, "catalog.json")), null);
	}
	root(version: string) {
		return join(this.home, "versions", id(version));
	}
	async list() {
		const v = await this.current();
		return v ? (await readdir(this.root(v))).sort() : [];
	}
	async get(name: string) {
		const revision = await this.current();
		if (!revision) throw Error("Flow 不存在");
		return {
			id: id(name),
			revision,
			files: await filesAt(join(this.root(revision), name)),
		};
	}
	// Only the daemon's serialized request handler publishes catalog generations.
	async change(op: string, name: string, files: unknown, expected?: string) {
		id(name);
		const prev = await this.current();
		if (expected !== undefined && expected !== prev) throw Error("版本冲突");
		const next = randomUUID(),
			root = this.root(next),
			dir = join(root, name);
		try {
			if (prev) await cp(this.root(prev), root, { recursive: true });
			else await mkdir(root, { recursive: true });
			const exists = await optional(
				lstat(dir).then(() => true),
				false,
			);
			if (op !== "validate" && (op === "create" ? exists : !exists))
				throw Error(exists ? "Flow 已存在" : "Flow 不存在");
			await rm(dir, { recursive: true, force: true });
			if (op !== "delete") {
				checkFiles(files);
				for (const [path, text] of Object.entries(files)) {
					const target = join(dir, path);
					await mkdir(join(target, ".."), { recursive: true });
					await writeFile(target, text);
				}
			}
			for (const entry of await readdir(root))
				await loadFlow(join(root, entry));
			if (op === "validate") {
				await rm(root, { recursive: true, force: true });
				return { id: name, valid: true };
			}
			await save(join(this.home, "catalog.json"), next);
			return { id: name, revision: next };
		} catch (e) {
			await rm(root, { recursive: true, force: true });
			throw e;
		}
	}
}
