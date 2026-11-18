import { describe, expect, it } from "vitest";
import { AgentRunModel } from "../src/ability/agent-harness/executor.ts";
import { RuntimeOutcomeBridge } from "../src/ability/runtime-tools/bridge.ts";
import { validateAgentIdentity } from "../src/core/contracts/agent-identity.ts";
import type {
	AgentHarnessExtensions,
	FlowExecutionExtensions,
} from "../src/core/contracts/extensions.ts";
import type {
	AgentAssemblyIdentity,
	FlowAgentHarness,
	FlowDefinition,
	FlowPackage,
} from "../src/core/contracts/types.ts";
import { validateFlowValue } from "../src/core/contracts/variables.ts";
import { preflightFlow } from "../src/core/execution/preflight.ts";

const outcomes = [{ name: "完成", description: "已完成" }];
const call = (variables?: unknown) => ({
	toolName: "submit_flow_outcome",
	arguments: {
		outcome: "完成",
		...(variables === undefined ? {} : { variables }),
	},
});

function flow(
	kind: "新建Agent" | "复用Agent" | "执行自定义命令" | "执行Flow" = "新建Agent",
): FlowDefinition {
	return {
		id: "flow",
		name: "Flow",
		description: "contract",
		startNodeRef: "node",
		nodes: new Map([
			[
				"node",
				{
					ref: "node",
					name: "Node",
					action:
						kind === "执行Flow"
							? { kind, flow: "child" }
							: kind === "执行自定义命令"
								? { kind, request: { command: "test" }, branchReferences: [] }
								: { kind, prompt: "execute" },
					results: new Map([["完成", "已完成"]]),
					successors: new Map([["完成", { kind: "finish" }]]),
				},
			],
		]),
		parallels: new Map(),
	};
}

// These are port fixtures, deliberately never invoked during structural preflight.
const neverExecute = async (): Promise<never> => {
	throw new Error("unexpected execution");
};
const execution: FlowExecutionExtensions = {
	command: { execute: neverExecute },
	childFlow: { execute: neverExecute, resume: neverExecute },
	parallel: { execute: neverExecute },
};
const agent: AgentHarnessExtensions = {
	assembly: { preflight: () => undefined, open: neverExecute },
	continuity: { rebind: neverExecute, restore: neverExecute },
};

describe("Agent identity and ownership", () => {
	const assembly: AgentAssemblyIdentity = {
		hostId: "test",
		pluginId: "plugin",
		pluginVersion: "1",
		pluginDigest: "digest",
		profileId: "profile",
		paramsDigest: "params",
		resolvedCapabilityDigest: "capabilities",
	};

	it("compares all assembly fields regardless of property order and checks restored sessions", () => {
		const reversed = Object.fromEntries(
			Object.entries(assembly).reverse(),
		) as unknown as AgentAssemblyIdentity;
		const handle = {
			id: "agent",
			platformReference: "agent",
			sessionReference: "saved",
			assembly: reversed,
		};
		expect(() =>
			validateAgentIdentity(handle, {
				assembly,
				sessionReference: "saved",
				profile: { id: "profile" },
			}),
		).not.toThrow();
		expect(() =>
			validateAgentIdentity(handle, { sessionReference: "other" }),
		).toThrow("Session 身份不匹配");
		for (const field of Object.keys(assembly)) {
			expect(() =>
				validateAgentIdentity(
					{ ...handle, assembly: { ...assembly, [field]: "changed" } },
					{ assembly },
				),
			).toThrow("装配身份不匹配");
		}
	});

	it("closes a restored handle when its identity is rejected", async () => {
		let closed = 0;
		const harness: FlowAgentHarness = {
			open: async () => ({
				id: "agent",
				platformReference: "agent",
				assembly: { ...assembly, pluginDigest: "changed" },
			}),
			run: neverExecute,
			close: async () => {
				closed += 1;
			},
		};
		const model = new AgentRunModel(harness, {
			continuity: {
				rebind: neverExecute,
				restore: async (request) => ({
					...(await harness.open(request)),
					sessionReference: request.sessionReference,
				}),
			},
		});
		await model.start(
			"run",
			{ tools: [], skills: [] },
			"saved",
			undefined,
			assembly,
		);
		await expect(
			model.executeNode({
				runId: "run",
				action: "复用Agent",
				nodeExecutionReference: "restored",
				prompt: "execute",
				outcomes,
			}),
		).rejects.toThrow("装配身份不匹配");
		await model.end("run");
		expect(closed).toBe(1);
	});

	it("does not retain a closed binding when replacement fails", async () => {
		let opened = 0;
		let closed = 0;
		let bridge: Parameters<FlowAgentHarness["open"]>[0]["runtimeTools"];
		const harness: FlowAgentHarness = {
			open: async (request) => {
				if (opened++) throw new Error("open failed");
				bridge = request.runtimeTools;
				return { id: "agent", platformReference: "agent" };
			},
			run: async () => {
				await bridge.invoke(call());
				return { status: "completed" };
			},
			close: async () => {
				closed += 1;
			},
		};
		const model = new AgentRunModel(harness);
		const request = {
			runId: "run",
			action: "新建Agent" as const,
			nodeExecutionReference: "node",
			prompt: "execute",
			outcomes,
		};
		await model.executeNode(request);
		await expect(model.executeNode(request)).rejects.toThrow("open failed");
		await model.end("run");
		expect(closed).toBe(1);
	});
});

describe("Runtime outcome bridge", () => {
	it("accepts exactly one of concurrent submissions and owns detached evidence", async () => {
		const bridge = new RuntimeOutcomeBridge("first", outcomes);
		const variables = { value: { nested: [1, "two", null] } };
		const results = await Promise.allSettled([
			bridge.invoke(call(variables)),
			bridge.invoke(call()),
		]);
		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"rejected",
		]);
		variables.value.nested[0] = 99;
		expect(bridge.outcome?.variables).toEqual({
			value: { nested: [1, "two", null] },
		});
		const snapshot = bridge.outcome;
		if (snapshot) snapshot.result = "changed";
		expect(bridge.outcome?.result).toBe("完成");
	});

	it("revokes late callbacks permanently while another node is active", async () => {
		const first = new RuntimeOutcomeBridge("first", outcomes);
		const lateCall = first.invoke.bind(first);
		first.close();
		first.close();
		const second = new RuntimeOutcomeBridge("second", outcomes);
		await expect(lateCall(call())).rejects.toThrow("已关闭");
		expect(second.outcome).toBeUndefined();
		await second.invoke(call());
		expect(first.outcome).toBeUndefined();
		expect(second.outcome?.result).toBe("完成");
	});

	it("rejects wrong tools, outcomes, fields and result-scoped variables without consuming submission", async () => {
		const bridge = new RuntimeOutcomeBridge(
			"node",
			outcomes,
			new Map([["完成", ["允许"]]]),
		);
		await expect(
			bridge.invoke({ toolName: "other", arguments: {} }),
		).rejects.toThrow("不支持");
		await expect(
			bridge.invoke({
				toolName: "submit_flow_outcome",
				arguments: { outcome: "other" },
			}),
		).rejects.toThrow("不允许结果");
		await expect(
			bridge.invoke({
				toolName: "submit_flow_outcome",
				arguments: { outcome: "完成", extra: true },
			}),
		).rejects.toThrow("不允许字段");
		await expect(bridge.invoke(call({ 未声明: 1 }))).rejects.toThrow(
			"不允许变量",
		);
		await expect(bridge.invoke(call({ 允许: 1 }))).resolves.toMatchObject({
			stopExecution: true,
		});
	});

	it("snapshots declarations and freezes model-facing schemas", async () => {
		const names = ["允许"];
		const options = [{ name: "完成", description: "完成" }];
		const bridge = new RuntimeOutcomeBridge(
			"node",
			options,
			new Map([["完成", names]]),
		);
		names.push("注入");
		options[0].name = "注入";
		expect(Object.isFrozen(bridge.definitions[0].inputSchema)).toBe(true);
		await expect(bridge.invoke(call({ 注入: true }))).rejects.toThrow(
			"不允许变量",
		);
		await expect(bridge.invoke(call({ 允许: true }))).resolves.toBeDefined();
	});

	it("requires an execution identity and distinct nonempty outcomes", () => {
		expect(() => new RuntimeOutcomeBridge("", outcomes)).toThrow();
		expect(() => new RuntimeOutcomeBridge("node", [])).toThrow();
		expect(
			() => new RuntimeOutcomeBridge("node", [...outcomes, ...outcomes]),
		).toThrow();
	});
});

describe("untrusted JSON boundary", () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	const accessor = Object.defineProperty({}, "value", {
		enumerable: true,
		get() {
			throw new Error("getter must never run");
		},
	});
	const hidden = Object.defineProperty({}, "value", { value: true });
	const symbol = { [Symbol("value")]: true };
	const sparse = Array(2);
	const extended = Object.assign([1], { extra: 2 });
	it.each([
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["undefined", undefined],
		["function", () => 1],
		["bigint", 1n],
		["date", new Date()],
		["cycle", cyclic],
		["getter", accessor],
		["hidden", hidden],
		["symbol", symbol],
		["sparse", sparse],
		["array properties", extended],
	])(
		"rejects %s without losing data through serialization",
		async (_name, value) => {
			expect(() => validateFlowValue(value)).toThrow(/JSON|循环/);
			const bridge = new RuntimeOutcomeBridge("node", outcomes);
			await expect(bridge.invoke(call({ value }))).rejects.toThrow(/JSON|循环/);
			expect(bridge.outcome).toBeUndefined();
		},
	);

	it("accepts shared acyclic values and null-prototype dictionaries", () => {
		const shared = { value: [1, false, null] };
		expect(() => validateFlowValue({ a: shared, b: shared })).not.toThrow();
		expect(() =>
			validateFlowValue(Object.assign(Object.create(null), shared)),
		).not.toThrow();
	});
});

describe("capability preflight", () => {
	it("requires no optional extension for a plain new Agent", async () => {
		await expect(preflightFlow(flow())).resolves.toBeUndefined();
	});

	it.each([
		["复用Agent", "Agent Continuity"],
		["执行自定义命令", "Command Executor"],
		["执行Flow", "Child Flow Executor"],
	] as const)("rejects %s before any execution", async (kind, capability) => {
		await expect(preflightFlow(flow(kind))).rejects.toThrow(capability);
	});

	it("requires continuity for explicit restoration", async () => {
		await expect(
			preflightFlow(flow(), { sessionReference: "saved" }),
		).rejects.toThrow("Continuity");
	});

	it("checks child requirements and does not require unused reference extensions", async () => {
		const child: FlowPackage = {
			flow: flow("执行自定义命令"),
			path: "child/FLOW.md",
			resources: { packageRoot: "child", resourcePaths: new Map() },
		};
		const references = new Map([["child", child]]);
		await expect(
			preflightFlow(flow("执行Flow"), {
				references,
				execution: { childFlow: execution.childFlow },
			}),
		).rejects.toThrow("Command Executor");
		await expect(
			preflightFlow(flow(), { references }),
		).resolves.toBeUndefined();
		await expect(
			preflightFlow(flow("执行Flow"), { references, execution }),
		).resolves.toBeUndefined();
	});

	it("checks the actual profile through optional assembly", async () => {
		const definition = flow();
		const node = definition.nodes.get("node");
		if (node?.action.kind === "新建Agent")
			node.action.profile = { id: "missing" };
		await expect(preflightFlow(definition)).rejects.toThrow("Agent Assembly");
		await expect(
			preflightFlow(definition, {
				agent: {
					assembly: {
						open: neverExecute,
						preflight: () => {
							throw new Error("unknown profile");
						},
					},
				},
			}),
		).rejects.toThrow("unknown profile");
		await expect(preflightFlow(definition, { agent })).resolves.toBeUndefined();
	});

	it("requires parallel execution and rejects unsupported Agent branches", async () => {
		const definition = flow();
		definition.parallels.set("parallel", {
			ref: "parallel",
			branches: ["node"],
			joinRef: "join",
		});
		await expect(preflightFlow(definition)).rejects.toThrow(
			"Parallel Executor",
		);
		await expect(preflightFlow(definition, { execution })).rejects.toThrow(
			"仅支持命令",
		);
	});
});
