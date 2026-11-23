import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PiConfig, SkillFile } from "./session.ts";
import { parseNodeContract } from "./node-contract.ts";

function unavailable(): never { throw new Error("Managed Pi configuration unavailable"); }
function privateOwner(st: Stats, allowRoot = false) {
	return (st.uid === process.geteuid?.() || (allowRoot && st.uid === 0)) && (st.mode & 0o077) === 0;
}
export function absolute(path: unknown): string {
	if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) unavailable();
	return path;
}
export function directory(path: string) {
	const st = lstatSync(path);
	if (!st.isDirectory() || !privateOwner(st) || realpathSync(path) !== path) unavailable();
	return `${st.dev}:${st.ino}`;
}
export function layout(env: NodeJS.ProcessEnv, id: string) {
	if (id.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) unavailable();
	const root = absolute(env.URSI_EXECUTOR_ROOT);
	directory(root);
	const attempt = join(root, id);
	const workspace = join(attempt, "workspace");
	const binding = [attempt, workspace, join(workspace, "inputs"), join(workspace, "artifacts")].map(directory).join("/");
	return { attempt, workspace, binding };
}

function privateFile(path: string, allowRoot = false): number {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.nlink !== 1 || !privateOwner(st, allowRoot) || realpathSync(path) !== path) unavailable();
		return fd;
	} catch (error) { closeSync(fd); throw error; }
}
function policyFile(env: NodeJS.ProcessEnv, root: string) {
	const path = absolute(env.URSI_PI_POLICY);
	const parts = relative(root, path).split("/");
	if (parts[0] !== ".." && parts[1] === "workspace") unavailable();
	closeSync(privateFile(path, true));
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
const CONFIG_LIMIT = 2 * 1024 * 1024;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

function skillFiles(value: unknown, budget: { bytes: number; files: number }): SkillFile[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || (budget.files += value.length) > 4096) unavailable();
	const paths = new Set<string>();
	const files = value.map((v: unknown) => {
		if (!record(v) || !text(v.path, 4096) || v.path === 'SKILL.md' || !digest(v.sha256) ||
			typeof v.contentBase64 !== 'string') unavailable();
		const parts = v.path.split('/');
		if (parts.length > 64 || parts.some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f\x7f]/.test(p)) || paths.has(v.path)) unavailable();
		paths.add(v.path);
		budget.bytes += Buffer.byteLength(v.path) + v.contentBase64.length;
		if (budget.bytes > CONFIG_LIMIT) unavailable();
		const data = Buffer.from(v.contentBase64, 'base64');
		if (data.toString('base64') !== v.contentBase64 || sha256(data) !== v.sha256) unavailable();
		return { path: v.path, contentBase64: v.contentBase64, sha256: v.sha256 };
	});
	for (const path of paths) {
		for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
			if (parent === 'SKILL.md' || paths.has(parent)) unavailable();
		}
	}
	return files;
}

export function parseConfig(v: unknown): PiConfig {
	if (!record(v) || !text(v.systemPrompt, 256 * 1024) || !name(v.modelProfile) ||
		!Array.isArray(v.skills) || v.skills.length > 64 || !Array.isArray(v.tools) || v.tools.length > 64) unavailable();
	const budget = { bytes: 0, files: 0 };
	const skills = v.skills.map((s: unknown) => {
		if (!record(s) || !name(s.id) || typeof s.revision !== "number" || !Number.isSafeInteger(s.revision) || s.revision < 1 || !text(s.content, 256 * 1024)) unavailable();
		const files = skillFiles(s.files, budget);
		return { id: s.id, revision: s.revision, content: s.content, ...(files.length ? { files } : {}) };
	});
	const tools = v.tools.map((t: unknown) => {
		if (!record(t) || !name(t.id) || typeof t.schemaDigest !== "string" || !/^[a-f0-9]{64}$/.test(t.schemaDigest)) unavailable();
		return { id: t.id, schemaDigest: t.schemaDigest };
	});
	if ([skills, tools].some(list => new Set(list.map(x => x.id)).size !== list.length)) unavailable();
	return { systemPrompt: v.systemPrompt, modelProfile: v.modelProfile, skills, tools };
}
function privateJson(path: string, limit: number) {
	const fd = privateFile(path);
	try {
		const { size: bytes, mode, ctimeNs } = fstatSync(fd, { bigint: true });
		if (!bytes || bytes > limit || (mode & 0o7777n) !== 0o400n) unavailable();
		const data = Buffer.alloc(Number(bytes) + 1);
		let n = 0;
		while (n < data.length) {
			const count = readSync(fd, data, n, data.length - n, null);
			if (!count) break;
			n += count;
		}
		if (BigInt(n) !== bytes || fstatSync(fd, { bigint: true }).ctimeNs !== ctimeNs) unavailable();
		const raw = data.subarray(0, n);
		return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown, digest: sha256(raw) };
	} finally { closeSync(fd); }
}

export function acpEnvironment(env: NodeJS.ProcessEnv) {
	const root = absolute(env.URSI_EXECUTOR_ROOT);
	directory(root);
	const policy = policyFile(env, root);
	if (env.URSI_ACP_JOB === undefined) return { root, policy };
	const { value } = privateJson(absolute(env.URSI_ACP_JOB), 256 * 1024);
	if (!record(value) || !digest(value.configDigest)) unavailable();
	const cwd = absolute(value.cwd);
	const [attemptId, workspace, ...rest] = relative(root, cwd).split('/');
	if (!attemptId || workspace !== 'workspace' || rest.length) unavailable();
	const location = layout(env, attemptId);
	if (cwd !== location.workspace) unavailable();
	const frozen = privateJson(join(location.attempt, 'agent-config.json'), CONFIG_LIMIT);
	if (frozen.digest !== value.configDigest) unavailable();
	const config = parseConfig(frozen.value);
	const nodeContract = 'nodeContract' in value ? parseNodeContract(value.nodeContract) : undefined;
	return { root, policy, job: { cwd, binding: location.binding, attemptId, config, nodeContract } };
}
