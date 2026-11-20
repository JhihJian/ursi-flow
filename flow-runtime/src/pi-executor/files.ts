import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ExecutorError, parseAttemptRequest } from "../integrations/mcp/executor.ts";
import type { PiConfig } from "./session.ts";

function unavailable(): never { throw new ExecutorError("unavailable"); }
function privateOwner(st: Stats, allowRoot = false) {
	return (st.uid === process.geteuid?.() || (allowRoot && st.uid === 0)) && (st.mode & 0o077) === 0;
}
function absolute(path: string | undefined): string {
	if (!path || !isAbsolute(path) || resolve(path) !== path) unavailable();
	return path;
}
function directory(path: string) {
	const st = lstatSync(path);
	if (!st.isDirectory() || !privateOwner(st) || realpathSync(path) !== path) unavailable();
	return `${st.dev}:${st.ino}`;
}
export function layout(env: NodeJS.ProcessEnv, id: string) {
	parseAttemptRequest({ attemptId: id });
	const root = absolute(env.URSI_EXECUTOR_ROOT);
	directory(root);
	const attempt = join(root, id);
	const workspace = join(attempt, "workspace");
	try {
		const binding = [attempt, workspace, join(workspace, "inputs"), join(workspace, "artifacts")].map(directory).join("/");
		return { root, attempt, workspace, binding };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ExecutorError("not_found");
		throw error;
	}
}

export function privateFile(path: string, kind: "snapshot" | "ledger" | "policy" = "snapshot"): number {
	const flags = kind === "ledger" ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY;
	const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.nlink !== 1 || !privateOwner(st, kind === "policy") || realpathSync(path) !== path) unavailable();
		return fd;
	} catch (error) { closeSync(fd); throw error; }
}
export function policyFile(env: NodeJS.ProcessEnv, root: string) {
	const path = absolute(env.URSI_PI_POLICY);
	const parts = relative(root, path).split("/");
	if (parts[0] !== ".." && parts[1] === "workspace") unavailable();
	closeSync(privateFile(path, "policy"));
	return path;
}
function record(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function text(v: unknown, max: number): v is string {
	return typeof v === "string" && !!v.trim() && Buffer.byteLength(v) <= max;
}
function name(v: unknown): v is string {
	return text(v, 128) && v !== "." && v !== ".." && /^[\p{L}\p{N}_.-]+$/u.test(v);
}
export function parseConfig(v: unknown): PiConfig {
	if (!record(v) || !text(v.systemPrompt, 256 * 1024) || !name(v.modelProfile) ||
		!Array.isArray(v.skills) || v.skills.length > 64 || !Array.isArray(v.tools) || v.tools.length > 64) unavailable();
	const skills = v.skills.map((s: unknown) => {
		if (!record(s) || !name(s.id) || typeof s.revision !== "number" || !Number.isSafeInteger(s.revision) || s.revision < 1 || !text(s.content, 256 * 1024)) unavailable();
		return { id: s.id, revision: s.revision, content: s.content };
	});
	const tools = v.tools.map((t: unknown) => {
		if (!record(t) || !name(t.id) || typeof t.schemaDigest !== "string" || !/^[a-f0-9]{64}$/.test(t.schemaDigest)) unavailable();
		return { id: t.id, schemaDigest: t.schemaDigest };
	});
	if ([skills, tools].some(list => new Set(list.map(x => x.id)).size !== list.length)) unavailable();
	return { systemPrompt: v.systemPrompt, modelProfile: v.modelProfile, skills, tools };
}
export function snapshot(attempt: string) {
	const fd = privateFile(join(attempt, "agent-config.json"));
	try {
		const bytes = fstatSync(fd).size;
		if (!bytes || bytes > 2 * 1024 * 1024) unavailable();
		const data = Buffer.alloc(bytes + 1);
		let n = 0;
		while (n < data.length) {
			const count = readSync(fd, data, n, data.length - n, null);
			if (!count) break;
			n += count;
		}
		if (n !== bytes) unavailable();
		const raw = data.subarray(0, n);
		return { config: parseConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))), digest: createHash("sha256").update(raw).digest("hex") };
	} finally { closeSync(fd); }
}
