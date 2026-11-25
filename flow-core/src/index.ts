import { randomUUID } from "node:crypto";
import { parseFlow, renderCommandRequest } from "./parser.ts";
import {
	initializeVariables,
	pickDeclaredVariables,
	renderPrompt,
	requireOutcomeRoute,
	validateOutcomeVariables,
} from "./rules.ts";
import type {
	CommandRequest,
	FlowVariableDeclarations,
	FlowVariables,
	FlowValue,
} from "./types.ts";
import { isRecord, validateFlowValue, validateVariables } from "./variables.ts";

export type { FlowValue, FlowVariables };
export type { CommandRequest };
export { readCommandVariables } from "./rules.ts";

export interface ReadyOptions {
	flowId?: string;
	variables?: FlowVariables;
}

export type Outcome = { outcome: string; variables?: FlowVariables };

/** 一个节点步骤提交一次结果；并行步骤按分支各提交一次。 */
export type StepResult =
	| (Outcome & { stepId: string })
	| { stepId: string; branches: Record<string, Outcome> };

type VariableDescriptions = Record<string, { description: string }>;
export interface OutcomeOption {
	name: string;
	description: string;
	variables: VariableDescriptions;
}

export type FlowDestination =
	| { kind: "node"; ref: string }
	| { kind: "parallel"; ref: string }
	| { kind: "finish" };

type CoreRoute = OutcomeOption & { destination: FlowDestination };

export interface CoreNode {
	name: string;
	kind: "agent" | "confirm" | "command";
	/** Agent 提示词或确认正文。命令节点为空串。 */
	prompt: string;
	/** 命令节点的请求模板，渲染时才代入变量与分支结果。 */
	request?: CommandRequest;
	/** 命令 stdout 是否按变量结果信封解析。 */
	output?: "variables";
	routes: CoreRoute[];
}

/** 并行分支：一个只由并行开始点进入的命令节点。 */
export interface ParallelBranch {
	stepId: string;
	ref: string;
	nodeRef: string;
	name: string;
	request: CommandRequest;
}

export interface CoreParallel {
	ref: string;
	branches: string[];
	joinRef: string;
	joinName: string;
}

export interface CoreFlow {
	id: string;
	name: string;
	description: string;
	startNodeRef: string;
	variables: FlowVariableDeclarations;
	nodes: Record<string, CoreNode>;
	parallels: Record<string, CoreParallel>;
}

export interface AgentStep {
	kind: "agent";
	stepId: string;
	nodeRef: string;
	name: string;
	prompt: string;
	options: OutcomeOption[];
}

export interface ConfirmStep {
	kind: "confirm";
	stepId: string;
	nodeRef: string;
	name: string;
	prompt: string;
	options: OutcomeOption[];
}

export interface CommandStep {
	kind: "command";
	stepId: string;
	nodeRef: string;
	name: string;
	request: CommandRequest;
	output: "variables" | undefined;
	options: OutcomeOption[];
}

/** 并行步骤：分支请求已按入参渲染，汇合步骤要等分支结果后才生成。 */
export interface ParallelStep {
	kind: "parallel";
	stepId: string;
	parallelRef: string;
	input: FlowVariables;
	branches: ParallelBranch[];
	join: { nodeRef: string; name: string };
}

export type CurrentStep = AgentStep | ConfirmStep | CommandStep | ParallelStep;

export interface CompletedStep {
	stepId: string;
	nodeRef: string;
	result: Outcome;
}

/** A JSON snapshot. Treat returned snapshots as read-only values. */
export interface FlowContext {
	flow: CoreFlow;
	variables: FlowVariables;
	current: CurrentStep | null;
	steps: CompletedStep[];
}

export function ready(
	flowMd: string,
	options: ReadyOptions = {},
): { context: FlowContext } {
	const parsed = parseFlow(flowMd, options.flowId ?? "inline");
	const nodes: Record<string, CoreNode> = {};
	for (const node of parsed.nodes.values()) {
		const action = node.action;
		const routes: CoreRoute[] = [...node.results].map(
			([name, description]) => ({
				name,
				description,
				destination: requireOutcomeRoute(
					node.ref,
					name,
					node.successors.get(name),
				),
				variables: node.resultVariables?.get(name) ?? {},
			}),
		);
		nodes[node.ref] =
			action.kind === "执行自定义命令"
				? {
						name: node.name,
						kind: "command",
						prompt: "",
						request: action.request,
						...(action.request.output === "variables"
							? { output: "variables" as const }
							: {}),
						routes,
					}
				: {
						name: node.name,
						kind: action.kind === "confirm" ? "confirm" : "agent",
						prompt: action.prompt,
						routes,
					};
	}
	const parallels: Record<string, CoreParallel> = {};
	for (const parallel of parsed.parallels.values())
		parallels[parallel.ref] = {
			ref: parallel.ref,
			branches: [...parallel.branches],
			joinRef: parallel.joinRef,
			joinName: parsed.nodes.get(parallel.joinRef)?.name ?? parallel.joinRef,
		};
	const flow: CoreFlow = {
		id: parsed.id,
		name: parsed.name,
		description: parsed.description,
		startNodeRef: parsed.startNodeRef,
		variables: parsed.variables ?? {},
		nodes,
		parallels,
	};
	const variables = initializeVariables(
		flow.variables,
		options.variables === undefined ? {} : options.variables,
	);
	return {
		context: {
			flow,
			variables,
			current: prepareStep(
				flow,
				{ kind: "node", ref: flow.startNodeRef },
				variables,
				{},
			),
			steps: [],
		},
	};
}

export function submit(
	context: FlowContext,
	result: StepResult,
): { context: FlowContext } {
	const { current, flow } = context;
	if (current === null) throw new Error("流程已结束");
	if (!isRecord(result) || Object.keys(result).some(
		(key) =>
			key !== "stepId" &&
			key !== "outcome" &&
			key !== "variables" &&
			key !== "branches",
	)) throw new Error("步骤回执只能包含 stepId、outcome、branches 和可选的 variables");
	if (result.stepId !== current.stepId) throw new Error("回执与当前 stepId 不匹配");
	if (current.kind === "parallel") return submitParallel(context, current, result);
	if (Object.hasOwn(result, "branches"))
		throw new Error("只有并行步骤可以提交 branches");
	return submitNode(context, current, result);
}

function submitNode(
	context: FlowContext,
	current: AgentStep | ConfirmStep | CommandStep,
	result: Record<string, unknown>,
): { context: FlowContext } {
	validateFlowValue(result);
	const outcome = result.outcome;
	if (typeof outcome !== "string") throw new Error("outcome 必须是结果边名");
	const node = getNode(context.flow, current.nodeRef);
	const route = requireOutcomeRoute(
		current.nodeRef,
		outcome,
		node.routes.find(({ name }) => name === outcome),
	);
	if (current.kind === "confirm" && Object.hasOwn(result, "variables"))
		throw new Error("人工确认只提交结果名，不能提交变量");
	const variables = result.variables as FlowVariables | undefined;
	if (variables !== undefined) validateVariables(variables);
	validateOutcomeVariables(context.flow.variables, route.variables, variables);
	const next = {
		...context.variables,
		...pickDeclaredVariables(context.flow.variables, variables),
	};
	return {
		context: {
			flow: context.flow,
			variables: next,
			current: prepareStep(
				context.flow,
				route.destination,
				next,
				pickDeclaredVariables(route.variables, variables),
			),
			steps: [
				...context.steps,
				{
					stepId: current.stepId,
					nodeRef: current.nodeRef,
					result: {
						outcome: route.name,
						...(variables === undefined
							? {}
							: { variables: structuredClone(variables) }),
					},
				},
			],
		},
	};
}

/** 并行步骤收齐全部分支结果后，直接生成汇合命令步骤。 */
function submitParallel(
	context: FlowContext,
	current: ParallelStep,
	result: Record<string, unknown>,
): { context: FlowContext } {
	validateFlowValue(result);
	if (Object.hasOwn(result, "outcome") || Object.hasOwn(result, "variables"))
		throw new Error("并行步骤只逐分支提交结果");
	if (!isRecord(result.branches)) throw new Error("并行步骤需要 branches 对象");
	const branchRefs = current.branches.map((branch) => branch.ref);
	for (const ref of Object.keys(result.branches))
		if (!branchRefs.includes(ref)) throw new Error(`并行步骤没有分支: ${ref}`);
	const globals: Record<string, FlowVariables> = {};
	const branchInputs = new Map<string, FlowVariables>();
	const steps = [...context.steps];
	for (const branch of current.branches) {
		const reply = result.branches[branch.ref];
		if (!isRecord(reply)) throw new Error(`缺少并行分支结果: ${branch.ref}`);
		if (reply.outcome !== "已执行")
			throw new Error(`并行分支 ${branch.ref} 的结果必须是“已执行”`);
		const variables = reply.variables as FlowVariables | undefined;
		if (variables !== undefined) validateVariables(variables);
		const route = requireOutcomeRoute(
			branch.nodeRef,
			"已执行",
			getNode(context.flow, branch.nodeRef).routes.find(
				({ name }) => name === "已执行",
			),
		);
		validateOutcomeVariables(context.flow.variables, route.variables, variables);
		globals[branch.ref] = pickDeclaredVariables(context.flow.variables, variables);
		branchInputs.set(branch.ref, pickDeclaredVariables(route.variables, variables));
		steps.push({
			stepId: branch.stepId,
			nodeRef: branch.nodeRef,
			result: {
				outcome: "已执行",
				...(variables === undefined
					? {}
					: { variables: structuredClone(variables) }),
			},
		});
	}
	const variables = mergeBranchVariables(context.variables, globals);
	const joinRef = context.flow.parallels[current.parallelRef].joinRef;
	const join = getNode(context.flow, joinRef);
	return {
		context: {
			flow: context.flow,
			variables,
			current: prepareCommandStep(
				context.flow,
				joinRef,
				join,
				variables,
				current.input,
				branchInputs,
			),
			steps,
		},
	};
}

/** 分支写全局变量时按分支名排序合并；两个分支写同一变量直接失败。 */
function mergeBranchVariables(
	base: FlowVariables,
	patches: Record<string, FlowVariables>,
): FlowVariables {
	const merged = structuredClone(base);
	const owners = new Map<string, string>();
	for (const branch of Object.keys(patches).sort()) {
		for (const [name, value] of Object.entries(patches[branch] ?? {})) {
			const previous = owners.get(name);
			if (previous)
				throw new Error(
					`并行分支“${previous}”与“${branch}”同时写入变量: ${name}`,
				);
			owners.set(name, branch);
			merged[name] = structuredClone(value);
		}
	}
	return merged;
}

function prepareStep(
	flow: CoreFlow,
	destination: FlowDestination,
	variables: FlowVariables,
	input: FlowVariables,
): CurrentStep | null {
	if (destination.kind === "finish") return null;
	if (destination.kind === "parallel")
		return prepareParallelStep(flow, destination.ref, variables, input);
	const node = getNode(flow, destination.ref);
	return node.kind === "command"
		? prepareCommandStep(flow, destination.ref, node, variables, input)
		: {
				kind: node.kind,
				stepId: randomUUID(),
				nodeRef: destination.ref,
				name: node.name,
				prompt: renderPrompt(node.prompt, variables, input),
				options: optionsOf(flow, node),
			};
}

function prepareParallelStep(
	flow: CoreFlow,
	parallelRef: string,
	variables: FlowVariables,
	input: FlowVariables,
): ParallelStep {
	const parallel = flow.parallels[parallelRef];
	if (!parallel) throw new Error(`并行开始点不存在: ${parallelRef}`);
	return {
		kind: "parallel",
		stepId: randomUUID(),
		parallelRef,
		input: structuredClone(input),
		branches: parallel.branches.map((ref) => {
			const node = getNode(flow, ref);
			if (!node.request) throw new Error(`并行分支不是命令节点: ${ref}`);
			return {
				stepId: randomUUID(),
				ref,
				nodeRef: ref,
				name: node.name,
				request: renderCommandRequest(node.request, input, new Map(), variables),
			};
		}),
		join: { nodeRef: parallel.joinRef, name: parallel.joinName },
	};
}

function prepareCommandStep(
	flow: CoreFlow,
	nodeRef: string,
	node: CoreNode,
	variables: FlowVariables,
	input: FlowVariables,
	branches: ReadonlyMap<string, FlowVariables> = new Map(),
): CommandStep {
	if (!node.request) throw new Error(`命令节点缺少请求: ${nodeRef}`);
	return {
		kind: "command",
		stepId: randomUUID(),
		nodeRef,
		name: node.name,
		request: renderCommandRequest(node.request, input, branches, variables),
		output: node.output,
		options: optionsOf(flow, node),
	};
}

function optionsOf(flow: CoreFlow, node: CoreNode): OutcomeOption[] {
	return node.routes.map(({ name, description, variables: local }) => ({
		name,
		description,
		variables:
			node.kind === "confirm"
				? {}
				: Object.fromEntries(
						[
							...Object.entries(flow.variables),
							...Object.entries(local),
						].map(
							([key, { description }]) => [key, { description }],
						),
					),
	}));
}

function getNode(flow: CoreFlow, ref: string): CoreNode {
	if (!Object.hasOwn(flow.nodes, ref)) throw new Error(`工作节点不存在: ${ref}`);
	return flow.nodes[ref];
}
