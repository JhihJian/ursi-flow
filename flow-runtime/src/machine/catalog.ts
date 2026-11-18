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
import { FlowSyntaxError } from "../core/definition/parser.ts";
import { BusinessError, invalid } from "./errors.ts";

function validId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][\w-]{0,95}$/.test(value);
}
export function id(value: unknown): string {
	if (!validId(value)) throw invalid("非法标识");
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
		throw invalid("需要包含 FLOW.md 的文件集合");
	for (const [path, text] of Object.entries(files)) {
		if (
			!(
				path === "FLOW.md" ||
				/^(references|scripts)\/(?:[^/\\\x00]+\/)*[^/\\\x00]+$/.test(path)
			) ||
			path.split("/").some((s) => s === "." || s === "..") ||
			typeof text !== "string"
		)
			throw invalid("非法包内文件");
		for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
			if (Object.hasOwn(files, path.slice(0, i))) throw invalid("包内文件与目录重名");
		}
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
		const revision = await optional(readJson(join(this.home, "catalog.json")), undefined);
		if (revision === undefined) return null;
		if (!validId(revision)) throw Error("已保存的目录修订无效");
		return revision;
	}
	root(version: string) {
		if (!validId(version)) throw Error("目录修订无效");
		return join(this.home, "versions", version);
	}
	async list() {
		const v = await this.current();
		return v ? (await readdir(this.root(v))).sort() : [];
	}
	async get(name: string) {
		id(name);
		const revision = await this.current();
		if (!revision || !(await readdir(this.root(revision))).includes(name))
			throw new BusinessError("not_found", "Flow 不存在");
		return {
			id: name,
			revision,
			files: await filesAt(join(this.root(revision), name)),
		};
	}
	// Only the daemon's serialized request handler publishes catalog generations.
	async change(op: string, name: string, files: unknown, expected?: string) {
		id(name);
		if (expected !== undefined && typeof expected !== "string")
			throw invalid("expectedRevision 必须是字符串");
		const prev = await this.current();
		if (expected !== undefined && expected !== prev)
			throw new BusinessError("conflict", "版本冲突");
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
			if (op === "create" && exists) throw new BusinessError("conflict", "Flow 已存在");
			if ((op === "update" || op === "delete") && !exists)
				throw new BusinessError("not_found", "Flow 不存在");
			await rm(dir, { recursive: true, force: true });
			if (op !== "delete") {
				checkFiles(files);
				for (const [path, text] of Object.entries(files)) {
					const target = join(dir, path);
					try {
						await mkdir(join(target, ".."), { recursive: true });
						await writeFile(target, text);
					} catch (e) {
						if ((e as NodeJS.ErrnoException).code === "ENAMETOOLONG")
							throw invalid("包内路径过长");
						throw e;
					}
				}
			}
			for (const entry of await readdir(root)) {
				try {
					await loadFlow(join(root, entry));
				} catch (e) {
					// Only package validation in the staged generation is caller input.
					if (!(e instanceof Error) || "errno" in e ||
						(e.constructor !== Error && !(e instanceof FlowSyntaxError))) throw e;
					// A pre-existing broken dependency is storage corruption. Check the
					// published closure before attributing a failure to the proposed edit.
					if (prev) {
						const published = this.root(prev);
						for (const pkg of await readdir(published)) await loadFlow(join(published, pkg));
					}
					throw invalid(e.message);
				}
			}
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
