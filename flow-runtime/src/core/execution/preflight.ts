import { normalizeAgentCapabilities } from "../contracts/agent-capabilities.ts";
import type {
	AgentHarnessExtensions,
	FlowExecutionExtensions,
} from "../contracts/extensions.ts";
import type {
	AgentAssemblyRequest,
	FlowDefinition,
	FlowDestination,
	FlowNode,
	FlowPackage,
} from "../contracts/types.ts";

/**
 * Check the complete reachable reference closure before creating a business Run.
 * This function does not open sessions, create facts, or execute host actions.
 */
export async function preflightFlow(
	flow: FlowDefinition,
	options: {
		agent?: AgentHarnessExtensions;
		execution?: FlowExecutionExtensions;
		references?: ReadonlyMap<string, FlowPackage>;
		cwd?: string;
		sessionReference?: string;
	} = {},
): Promise<void> {
	const visited = new Set<FlowDefinition>();
	const assemblies: AgentAssemblyRequest[] = [];
	const requireCapability = (available: unknown, name: string) => {
		if (!available) throw new Error(`Flow 缺少扩展能力: ${name}`);
	};
	if (options.execution?.confirm === false)
		throw new Error("本地执行器暂不支持人工确认节点: confirm");
	if (options.sessionReference)
		requireCapability(options.agent?.continuity, "Agent Continuity");

	const visit = (definition: FlowDefinition) => {
		if (visited.has(definition)) return;
		visited.add(definition);
		const capabilities = normalizeAgentCapabilities(definition.capabilities);
		if (options.agent?.continuity?.toolSchemaMode === "fixed")
			assertFixedToolSchemas(definition);
		if (definition.parallels.size) {
			requireCapability(options.execution?.parallel, "Parallel Executor");
			for (const parallel of definition.parallels.values()) {
				for (const ref of parallel.branches) {
					if (definition.nodes.get(ref)?.action.kind !== "执行自定义命令")
						throw new Error(`并行分支仅支持命令节点: ${ref}`);
				}
			}
		}
		for (const node of definition.nodes.values()) {
			const action = node.action;
			switch (action.kind) {
				case "执行自定义命令":
					requireCapability(options.execution?.command, "Command Executor");
					break;
				case "执行Flow": {
					requireCapability(
						options.execution?.childFlow,
						"Child Flow Executor",
					);
					const child = options.references?.get(action.flow);
					if (!child)
						throw new Error(`被引用的 Flow 未在闭包中加载: ${action.flow}`);
					visit(child.flow);
					break;
				}
				case "复用Agent":
					if (action.profile)
						throw new Error("复用Agent 不能指定 Profile 或 Profile 参数");
					requireCapability(options.agent?.continuity, "Agent Continuity");
					break;
				case "新建Agent":
					if (
						action.profile ||
						capabilities.tools.length ||
						capabilities.skills.length
					) {
						requireCapability(options.agent?.assembly, "Agent Assembly");
					}
					if (options.agent?.assembly) {
						assemblies.push({
							capabilities,
							...(action.profile ? { profile: action.profile } : {}),
						});
					}
					break;
			}
		}
	};
	visit(flow);
	// Finish structural checks first; then ask the host to validate actual profiles.
	for (const request of assemblies) {
		const assembly = options.agent?.assembly;
		if (
			request.profile &&
			/\{(?:var|input)\./.test(JSON.stringify(request.profile.params ?? {}))
		) {
			if (!assembly?.preflightDeferred)
				throw new Error("宿主不支持动态 Profile 参数预检");
			await assembly.preflightDeferred(
				{
					capabilities: structuredClone(request.capabilities),
					profileId: request.profile.id,
				},
				options.cwd,
			);
		} else await assembly?.preflight(structuredClone(request), options.cwd);
	}
}

export function runtimeToolsForNode(flow: FlowDefinition, node: FlowNode) {
	const names = [
		...new Set(
			[...node.results.keys()].flatMap((name) => [
				...Object.keys(flow.variables ?? {}),
				...Object.keys(node.resultVariables?.get(name) ?? {}),
			]),
		),
	];
	return [
		{
			name: "submit_flow_outcome",
			description:
				"Submit the current Flow node result exactly once after completing its work.",
			inputSchema: {
				type: "object",
				properties: {
					outcome: {
						type: "string",
						enum: [...node.results.keys()],
					},
					variables: {
						type: "object",
						...(names.length
							? {
									properties: Object.fromEntries(
										names.map((name) => [name, {}]),
									),
									additionalProperties: false,
								}
							: {}),
					},
				},
				required: ["outcome"],
				additionalProperties: false,
			},
		},
	];
}

function assertFixedToolSchemas(flow: FlowDefinition): void {
	const schemas = new Map(
		[...flow.nodes]
			.filter(
				([, node]) =>
					node.action.kind === "新建Agent" || node.action.kind === "复用Agent",
			)
			.map(([ref, node]) => [
				ref,
				JSON.stringify(runtimeToolsForNode(flow, node)),
			]),
	);
	const ids = new Map(
		[...new Set(schemas.values())].map((schema, index) => [schema, index]),
	);
	const seen = new Set<string>();
	const queue: { destination: FlowDestination; schema?: number }[] = [
		{ destination: { kind: "node", ref: flow.startNodeRef } },
	];
	for (let index = 0; index < queue.length; index++) {
		const { destination, schema } = queue[index];
		if (destination.kind === "finish") continue;
		const key = JSON.stringify([destination.kind, destination.ref, schema]);
		if (seen.has(key)) continue;
		seen.add(key);
		if (destination.kind === "parallel") {
			const group = flow.parallels.get(destination.ref);
			if (group)
				queue.push({
					destination: { kind: "node", ref: group.joinRef },
					schema,
				});
			continue;
		}
		const node = flow.nodes.get(destination.ref);
		if (!node) continue;
		let next = schema;
		if (node.action.kind === "新建Agent" || node.action.kind === "复用Agent") {
			next = ids.get(schemas.get(node.ref) ?? "");
			if (
				node.action.kind === "复用Agent" &&
				schema !== undefined &&
				schema !== next
			)
				throw new Error("宿主 Continuity 不支持复用时改变 Runtime 工具 schema");
		}
		for (const successor of node.successors.values())
			queue.push({ destination: successor, schema: next });
	}
}
