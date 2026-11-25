import { connect, type Socket } from "node:net";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import { ExecutorError, type ExecutorErrorCode, type ExecutorResult, type ExecutorStartRequest, type ExecutorStatus } from "ursi-executor-sdk";
export { ExecutorError, LEGACY_VERSION as MCP_PROTOCOL_VERSION, parseAttemptRequest, parseStartRequest } from "ursi-executor-sdk";
export type { ExecutorErrorCode, ExecutorResult, ExecutorStartRequest, ExecutorStatus } from "ursi-executor-sdk";
export const EXECUTOR_SERVER_NAME = "ursi-flow-executor";
export const EXECUTOR_SERVER_VERSION = "0.1.0";

export interface RuntimeJob {
	executorRef?: unknown;
	id: string;
	flow: string;
	revision: string;
	cwd: string;
	variables: Record<string, unknown>;
	status: string;
}

export interface RuntimeClient {
	startPinned(
		id: string,
		flow: string,
		cwd: string,
		variables: Record<string, unknown>,
		revision: string,
	): Promise<RuntimeJob>;
	get(id: string): Promise<RuntimeJob>;
	stop(id: string): Promise<RuntimeJob>;
}

class RuntimeError extends Error {
	readonly code: ExecutorErrorCode;
	constructor(code: ExecutorErrorCode) {
		super(code);
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function job(value: unknown): RuntimeJob {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.flow !== "string" ||
		typeof value.revision !== "string" ||
		typeof value.cwd !== "string" ||
		!isRecord(value.variables) ||
		typeof value.status !== "string"
	)
		throw new RuntimeError("unavailable");
	return value as unknown as RuntimeJob;
}

function mapRuntimeCode(value: unknown): ExecutorErrorCode {
	if (value === "not_found" || value === "conflict" || value === "busy") return value;
	if (value === "invalid_input") return "invalid";
	return "unavailable";
}

async function requestRuntime(
	socketPath: string,
	op: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	return new Promise((resolveReply, reject) => {
		let settled = false;
		let size = 0;
		const chunks: Buffer[] = [];
		const socket: Socket = connect(socketPath);
		const finish = (error?: Error, value?: unknown) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (error) reject(error);
			else resolveReply(value);
		};
		socket.setTimeout(45_000, () => finish(new RuntimeError("unavailable")));
		socket.once("error", () => finish(new RuntimeError("unavailable")));
		socket.on("data", (chunk) => {
			size += chunk.length;
			if (size > 4 * 1024 * 1024) return finish(new RuntimeError("unavailable"));
			chunks.push(chunk);
		});
		socket.once("close", () => {
			if (settled) return;
			try {
				const reply: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (!isRecord(reply) || reply.v !== 1) throw new Error("protocol");
				if (Object.hasOwn(reply, "data") && !Object.hasOwn(reply, "error")) {
					finish(undefined, reply.data);
					return;
				}
				if (typeof reply.error === "string") {
					finish(new RuntimeError(mapRuntimeCode(reply.code)));
					return;
				}
				throw new Error("protocol");
			} catch {
				finish(new RuntimeError("unavailable"));
			}
		});
		socket.once("connect", () => {
			socket.end(JSON.stringify({ v: 1, op, args }) + "\n");
		});
	});
}

export class UnixRuntimeClient implements RuntimeClient {
	private readonly socketPath: string;
	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}
	async startPinned(
		id: string,
		flow: string,
		cwd: string,
		variables: Record<string, unknown>,
		revision: string,
	) {
		try {
			return job(
				await requestRuntime(this.socketPath, "run.startPinned", {
					id,
					flow,
					cwd,
					variables,
					revision,
				}),
			);
		} catch (error) {
			if (error instanceof RuntimeError) throw new ExecutorError(error.code);
			throw new ExecutorError("unavailable");
		}
	}
	async get(id: string) {
		try {
			return job(await requestRuntime(this.socketPath, "run.get", { id }));
		} catch (error) {
			if (error instanceof RuntimeError) throw new ExecutorError(error.code);
			throw new ExecutorError("unavailable");
		}
	}
	async stop(id: string) {
		try {
			return job(await requestRuntime(this.socketPath, "run.stop", { id }));
		} catch (error) {
			if (error instanceof RuntimeError) throw new ExecutorError(error.code);
			throw new ExecutorError("unavailable");
		}
	}
}

interface AdminConfig {
	root: string;
	flow: string;
	revision: string;
	socket: string;
}

function adminConfig(env: NodeJS.ProcessEnv): AdminConfig {
	const root = env.URSI_EXECUTOR_ROOT;
	const flow = env.URSI_EXECUTOR_FLOW;
	const revision = env.URSI_EXECUTOR_FLOW_REVISION;
	const home = env.URSI_FLOW_HOME;
	if (
		typeof root !== "string" ||
		typeof flow !== "string" ||
		typeof revision !== "string" ||
		typeof home !== "string" ||
		!root ||
		!flow ||
		!revision ||
		!home ||
		!isAbsolute(root) ||
		!isAbsolute(home) ||
		root.includes("\0") ||
		home.includes("\0") ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(flow) ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(revision)
	)
		throw new ExecutorError("unavailable");
	return { root: normalize(root), flow, revision, socket: join(normalize(home), "runtime.sock") };
}

async function ownedDirectory(path: string, missing: ExecutorErrorCode = "unavailable") {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new ExecutorError("unavailable");
		if (process.getuid && info.uid !== process.getuid()) throw new ExecutorError("unavailable");
		const actual = await realpath(path);
		if (actual !== normalize(path)) throw new ExecutorError("unavailable");
		return actual;
	} catch (error) {
		if (error instanceof ExecutorError) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") throw new ExecutorError(missing);
		throw new ExecutorError("unavailable");
	}
}

async function ownedPath(root: string, attemptId: string, createArtifacts: boolean) {
	const rootReal = await ownedDirectory(root);
	const attempt = join(rootReal, attemptId);
	await ownedDirectory(attempt, "not_found");
	const workspace = await ownedDirectory(join(attempt, "workspace"), "not_found");
	const artifacts = join(workspace, "artifacts");
	try {
		await ownedDirectory(artifacts, "not_found");
	} catch (error) {
		if (!(createArtifacts && error instanceof ExecutorError && error.code === "not_found")) {
			if (!createArtifacts && error instanceof ExecutorError && error.code === "not_found")
				return { workspace, artifacts };
			throw error;
		}
		try {
			await mkdir(artifacts, { mode: 0o700 });
		} catch {
			throw new ExecutorError("unavailable");
		}
		await ownedDirectory(artifacts);
	}
	return { workspace, artifacts };
}

function result(
	attemptId: string,
	artifactDirectoryRef: string,
	status: ExecutorStatus,
): ExecutorResult {
	return {
		attemptId,
		status,
		artifactDirectoryRef,
		backendRunRef: `flow:${attemptId}`,
	};
}

function status(value: string): ExecutorStatus {
	if (value === "running") return "running";
	if (value === "completed") return "succeeded";
	if (value === "failed") return "failed";
	if (value === "stopped") return "cancelled";
	return "unverified";
}

function sameVariables(value: Record<string, unknown>, text: string) {
	return Object.keys(value).length === 1 && value["任务"] === text;
}

export class ExecutorAdapter {
	private readonly config: AdminConfig;
	private readonly runtime: RuntimeClient;
	constructor(
		env: NodeJS.ProcessEnv = process.env,
		runtime?: RuntimeClient,
	) {
		this.config = adminConfig(env);
		this.runtime = runtime ?? new UnixRuntimeClient(this.config.socket);
	}

	async start(request: ExecutorStartRequest): Promise<ExecutorResult> {
		if (Object.keys(request.runConfig ?? {}).length) throw new ExecutorError("invalid");
		const paths = await ownedPath(this.config.root, request.attemptId, true);
		const task = { 任务: request.workInstruction };
		const run = await this.runtime.startPinned(
			request.attemptId,
			this.config.flow,
			paths.workspace,
			task,
			this.config.revision,
		);
		if (!this.matches(run, request.attemptId, paths.workspace, request.workInstruction))
			throw new ExecutorError("conflict");
		return result(request.attemptId, request.artifactDirectoryRef, status(run.status));
	}

	async inspect(request: { attemptId: string }): Promise<ExecutorResult> {
		const paths = await ownedPath(this.config.root, request.attemptId, false);
		const run = await this.runtime.get(request.attemptId);
		if (!this.matches(run, request.attemptId, paths.workspace)) throw new ExecutorError("conflict");
		return result(request.attemptId, `artifacts:${request.attemptId}`, status(run.status));
	}

	async cancel(request: { attemptId: string }): Promise<ExecutorResult> {
		const paths = await ownedPath(this.config.root, request.attemptId, false);
		const current = await this.runtime.get(request.attemptId);
		if (!this.matches(current, request.attemptId, paths.workspace)) throw new ExecutorError("conflict");
		const run = await this.runtime.stop(request.attemptId);
		if (!this.matches(run, request.attemptId, paths.workspace)) throw new ExecutorError("conflict");
		return result(request.attemptId, `artifacts:${request.attemptId}`, status(run.status));
	}

	private matches(run: RuntimeJob, attemptId: string, workspace: string, text?: string) {
		return (
			run.executorRef === undefined &&
			run.id === attemptId &&
			run.flow === this.config.flow &&
			run.revision === this.config.revision &&
			normalize(run.cwd) === normalize(workspace) &&
			(text === undefined || sameVariables(run.variables, text))
		);
	}
}
