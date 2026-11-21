#!/usr/bin/env node
import { createInterface } from "node:readline";
import {
	EXECUTOR_SERVER_NAME,
	EXECUTOR_SERVER_VERSION,
	ExecutorAdapter,
	ExecutorError,
	MCP_PROTOCOL_VERSION,
	parseAttemptRequest,
	parseStartRequest,
	type ExecutorResult,
} from "./executor.ts";

const JSON_RPC_VERSION = "2.0";
const TOOL_NAMES = ["executor_start", "executor_inspect", "executor_cancel"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: JsonRpcId;
	method: string;
	params?: unknown;
}

const tools = [
	{
		name: "executor_start",
		description: "Start or retrieve one configured executor attempt.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["attemptId", "workspaceRef", "artifactDirectoryRef", "workInstruction"],
			properties: {
				attemptId: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
				workspaceRef: { type: "string", pattern: "^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
				artifactDirectoryRef: { type: "string", pattern: "^artifacts:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
				workInstruction: { type: "string" },
				runConfig: { type: "object", additionalProperties: false },
			},
		},
	},
	{
		name: "executor_inspect",
		description: "Inspect one configured executor attempt.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["attemptId"],
			properties: { attemptId: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" } },
		},
	},
	{
		name: "executor_cancel",
		description: "Cancel one configured executor attempt.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["attemptId"],
			properties: { attemptId: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" } },
		},
	},
] as const;

function response(id: JsonRpcId, result: unknown) {
	return { jsonrpc: JSON_RPC_VERSION, id, result };
}
function errorResponse(id: JsonRpcId, code: number, message: string) {
	return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}
function toolError(code: ExecutorError["code"]) {
	return { isError: true, content: [{ type: "text", text: JSON.stringify({ code }) }] };
}
function toolSuccess(value: ExecutorResult) {
	const text = JSON.stringify(value);
	return { content: [{ type: "text", text }], structuredContent: value };
}

function isRequest(value: unknown): value is JsonRpcRequest {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).jsonrpc === JSON_RPC_VERSION &&
		typeof (value as Record<string, unknown>).method === "string" &&
		(!Object.hasOwn(value, "id") ||
			(value as Record<string, unknown>).id === null ||
			typeof (value as Record<string, unknown>).id === "string" ||
			typeof (value as Record<string, unknown>).id === "number")
	);
}

type ExecutorBackend = Pick<ExecutorAdapter, "start" | "inspect" | "cancel">;

export class McpStdioServer {
	private initialized = false;
	private initializationStarted = false;
	private readonly adapter?: ExecutorBackend;
	private readonly serverName: string;
	private readonly adapterError?: ExecutorError;
	constructor(adapter?: ExecutorBackend, serverName = EXECUTOR_SERVER_NAME) {
		this.serverName = serverName;
		if (adapter) {
			this.adapter = adapter;
			return;
		}
		try {
			this.adapter = new ExecutorAdapter();
		} catch (error) {
			this.adapterError = error instanceof ExecutorError ? error : new ExecutorError("unavailable");
		}
	}

	async handle(value: unknown): Promise<unknown | undefined> {
		if (!isRequest(value)) return errorResponse(null, -32600, "Invalid Request");
		const id = value.id ?? null;
		if (value.method === "notifications/initialized") {
			if (value.id !== undefined) return errorResponse(id, -32600, "Invalid Request");
			if (!this.initializationStarted) return undefined;
			this.initialized = true;
			return undefined;
		}
		if (value.method === "initialize") return this.initialize(id, value.params);
		if (!this.initialized) return value.id === undefined ? undefined : errorResponse(id, -32002, "Server not initialized");
		if (value.method === "tools/list") {
			if (value.params !== undefined && !isEmptyObject(value.params)) return value.id === undefined ? undefined : errorResponse(id, -32602, "Invalid params");
			return value.id === undefined ? undefined : response(id, { tools });
		}
		if (value.method === "tools/call") {
			if (value.id === undefined || value.id === null) return undefined;
			return this.call(id, value.params);
		}
		return value.id === undefined ? undefined : errorResponse(id, -32601, "Method not found");
	}

	private initialize(id: JsonRpcId, params: unknown) {
		if (this.initializationStarted) return errorResponse(id, -32600, "Invalid Request");
		if (
			!isRecord(params) ||
			params.protocolVersion !== MCP_PROTOCOL_VERSION ||
			!isRecord(params.capabilities) ||
			!isRecord(params.clientInfo) ||
			typeof params.clientInfo.name !== "string" ||
			typeof params.clientInfo.version !== "string"
		)
			return errorResponse(id, -32602, "Invalid params");
		this.initializationStarted = true;
		return response(id, {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: this.serverName, version: EXECUTOR_SERVER_VERSION },
		});
	}

	private async call(id: JsonRpcId, params: unknown) {
		if (!isRecord(params) || !hasOnly(params, ["name", "arguments", "_meta"]) || typeof params.name !== "string" ||
			(params._meta !== undefined && !isRecord(params._meta)))
			return errorResponse(id, -32602, "Invalid params");
		if (!TOOL_NAMES.includes(params.name as ToolName))
			return response(id, toolError("invalid"));
		try {
			if (!this.adapter) throw this.adapterError ?? new ExecutorError("unavailable");
			let value: ExecutorResult | undefined;
			switch (params.name) {
				case "executor_start":
					value = await this.adapter.start(parseStartRequest(params.arguments));
					break;
				case "executor_inspect":
					value = await this.adapter.inspect(parseAttemptRequest(params.arguments));
					break;
				case "executor_cancel":
					value = await this.adapter.cancel(parseAttemptRequest(params.arguments));
					break;
			}
			if (!value) return response(id, toolError("invalid"));
			return response(id, toolSuccess(value));
		} catch (error) {
			const code = error instanceof ExecutorError ? error.code : "unavailable";
			return response(id, toolError(code));
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isEmptyObject(value: unknown) {
	return isRecord(value) && Object.keys(value).length === 0;
}
function hasOnly(value: Record<string, unknown>, keys: readonly string[]) {
	return Object.keys(value).every((key) => keys.includes(key));
}

export async function runStdio(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
	server = new McpStdioServer(),
) {
	const lines = createInterface({ input, crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line.trim()) continue;
		if (Buffer.byteLength(line, "utf8") > 4 * 1024 * 1024) {
			output.write(`${JSON.stringify(errorResponse(null, -32600, "Invalid Request"))}\n`);
			continue;
		}
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			output.write(`${JSON.stringify(errorResponse(null, -32700, "Parse error"))}\n`);
			continue;
		}
		const reply = await server.handle(request);
		if (reply !== undefined) output.write(`${JSON.stringify(reply)}\n`);
	}
}

if (import.meta.main) {
	runStdio().catch(() => {
		process.exitCode = 1;
	});
}