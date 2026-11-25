import { randomUUID } from "node:crypto";
import { PACKAGE_REFERENCE_LINK, parseFlow } from "./parser.ts";
import {
	initializeVariables,
	pickDeclaredVariables,
	renderPrompt,
	requireOutcomeRoute,
	validateOutcomeVariables,
} from "./rules.ts";
import type { FlowVariableDeclarations, FlowVariables, FlowValue } from "./types.ts";
import { isRecord, validateFlowValue, validateVariables } from "./variables.ts";

export type { FlowValue, FlowVariables };

export interface ReadyOptions {
	flowId?: string;
	variables?: FlowVariables;
}

export type Outcome = { outcome: string; variables?: FlowVariables };
export type StepResult = Outcome & { stepId: string };

type VariableDescriptions = Record<string, { description: string }>;
export interface OutcomeOption {
	name: string;
	description: string;
	variables: VariableDescriptions;
}

type CoreRoute = OutcomeOption & {
	destination: { kind: "node"; ref: string } | { kind: "finish" };
};

export interface CoreNode {
	name: string;
	kind: "agent" | "confirm";
	prompt: string;
	routes: CoreRoute[];
}

export interface CoreFlow {
	id: string;
	name: string;
	description: string;
	startNodeRef: string;
	variables: FlowVariableDeclarations;
	nodes: Record<string, CoreNode>;
}

export interface CurrentStep {
	stepId: string;
	nodeRef: string;
	kind: CoreNode["kind"];
	prompt: string;
	options: OutcomeOption[];
}

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

export function ready(flowMd: string, options: ReadyOptions = {}): { context: FlowContext } {
	const parsed = parseFlow(flowMd, options.flowId ?? "inline");
	if (parsed.parallels.size > 0) throw new Error("Flow Core 不支持并行节点");

	const nodes = new Map<string, CoreNode>();
	for (const node of parsed.nodes.values()) {
		const action = node.action;
		if (action.kind !== "新建Agent" && action.kind !== "confirm")
			throw new Error(`Flow Core 不支持节点 ${node.ref} 的动作: ${action.kind}`);
		if (action.kind === "新建Agent" && (action.profile || action.executor))
			throw new Error(`Flow Core 不支持节点 ${node.ref} 的 Agent Profile 或专用执行器`);
		if (action.prompt.match(PACKAGE_REFERENCE_LINK))
			throw new Error(`Flow Core 不支持节点 ${node.ref} 的包内资料引用`);

		const routes: CoreRoute[] = [];
		for (const [name, description] of node.results) {
			const destination = requireOutcomeRoute(node.ref, name, node.successors.get(name));
			if (destination.kind === "parallel") throw new Error("Flow Core 不支持并行节点");
			routes.push({ name, description, destination, variables: node.resultVariables?.get(name) ?? {} });
		}
		nodes.set(node.ref, {
			name: node.name,
			kind: action.kind === "confirm" ? "confirm" : "agent",
			prompt: action.prompt,
			routes,
		});
	}
	const flow: CoreFlow = {
		id: parsed.id,
		name: parsed.name,
		description: parsed.description,
		startNodeRef: parsed.startNodeRef,
		variables: parsed.variables ?? {},
		nodes: Object.fromEntries(nodes),
	};
	const variables = initializeVariables(flow.variables, options.variables === undefined ? {} : options.variables);
	return {
		context: { flow, variables, current: prepareStep(flow, flow.startNodeRef, variables, {}), steps: [] },
	};
}

export function submit(context: FlowContext, result: StepResult): { context: FlowContext } {
	const { current, flow } = context;
	if (current === null) throw new Error("流程已结束");
	if (!isRecord(result) || Object.keys(result).some(
		(key) => key !== "stepId" && key !== "outcome" && key !== "variables",
	)) throw new Error("步骤回执只能包含 stepId、outcome 和可选的 variables");
	validateFlowValue(result);
	if (result.stepId !== current.stepId) throw new Error("回执与当前 stepId 不匹配");
	if (typeof result.outcome !== "string") throw new Error("outcome 必须是结果边名");
	const node = getNode(flow, current.nodeRef);
	const route = requireOutcomeRoute(
		current.nodeRef, result.outcome, node.routes.find(({ name }) => name === result.outcome),
	);
	if (node.kind === "confirm" && Object.hasOwn(result, "variables"))
		throw new Error("人工确认只提交结果名，不能提交变量");
	if (result.variables !== undefined) validateVariables(result.variables);
	validateOutcomeVariables(flow.variables, route.variables, result.variables);
	const variables = {
		...context.variables,
		...pickDeclaredVariables(flow.variables, result.variables),
	};
	const next = route.destination.kind === "finish"
		? null
		: prepareStep(flow, route.destination.ref, variables, pickDeclaredVariables(route.variables, result.variables));
	const receipt: Outcome = {
		outcome: route.name,
		...(result.variables === undefined ? {} : { variables: structuredClone(result.variables) }),
	};
	return {
		context: {
			flow,
			variables,
			current: next,
			steps: [...context.steps, { stepId: current.stepId, nodeRef: current.nodeRef, result: receipt }],
		},
	};
}

function getNode(flow: CoreFlow, ref: string): CoreNode {
	if (!Object.hasOwn(flow.nodes, ref)) throw new Error(`工作节点不存在: ${ref}`);
	return flow.nodes[ref];
}

function prepareStep(flow: CoreFlow, nodeRef: string, variables: FlowVariables, input: FlowVariables): CurrentStep {
	const node = getNode(flow, nodeRef);
	return {
		stepId: randomUUID(),
		nodeRef,
		kind: node.kind,
		prompt: renderPrompt(node.prompt, variables, input),
		options: node.routes.map(({ name, description, variables: local }) => ({
			name,
			description,
			variables: node.kind === "confirm"
				? {}
				: Object.fromEntries([...Object.entries(flow.variables), ...Object.entries(local)].map(
					([key, { description }]) => [key, { description }],
				)),
		})),
	};
}
