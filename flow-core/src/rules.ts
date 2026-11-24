import { renderTemplate } from "./parser.ts";
import type { FlowValue, FlowVariableDeclarations, FlowVariables } from "./types.ts";
import { validateVariableName, validateVariables } from "./variables.ts";

type Declarations = Readonly<Record<string, { description: string }>>;

export class VariableReferenceError extends Error {}
export class RouteNotFoundError extends Error {}

export function initializeVariables(
	declarations: FlowVariableDeclarations,
	supplied: unknown,
): FlowVariables {
	validateVariables(supplied);
	for (const name of Object.keys(supplied)) {
		if (!Object.hasOwn(declarations, name))
			throw new VariableReferenceError(`未声明全局变量: ${name}`);
	}
	const variables: FlowVariables = {};
	for (const [name, declaration] of Object.entries(declarations)) {
		if (declaration.default !== undefined)
			variables[name] = structuredClone(declaration.default);
		else if (!Object.hasOwn(supplied, name))
			throw new VariableReferenceError(`缺少必填全局变量: ${name}`);
	}
	return Object.assign(variables, structuredClone(supplied));
}

export function validateOutcomeVariables(
	global: Declarations,
	local: Declarations,
	variables?: FlowVariables,
): void {
	for (const name of Object.keys(variables ?? {})) {
		validateVariableName(name);
		const isGlobal = Object.hasOwn(global, name);
		const isLocal = Object.hasOwn(local, name);
		if (isGlobal && isLocal)
			throw new VariableReferenceError(`变量同时声明为全局和下一跳变量: ${name}`);
		if (!isGlobal && !isLocal)
			throw new VariableReferenceError(
				`结果未声明变量: ${name}。当前结果允许的变量: ${Object.keys(local).join(", ") || "无"}。复杂结果应放在声明的结果变量对象中提交。`,
			);
	}
	if (variables !== undefined) validateVariables(variables);
}

export function pickDeclaredVariables(
	declarations: Declarations,
	variables: FlowVariables = {},
): FlowVariables {
	return Object.fromEntries(
		Object.entries(variables)
			.filter(([name]) => Object.hasOwn(declarations, name))
			.map(([name, value]) => [name, structuredClone(value)]),
	);
}

export function requireOutcomeRoute<T>(
	nodeRef: string,
	outcome: string,
	route: T | undefined,
): T {
	if (route === undefined)
		throw new RouteNotFoundError(`节点 ${nodeRef} 没有结果“${outcome}”的去向`);
	return route;
}

export function renderPrompt(
	prompt: string,
	variables: FlowVariables,
	input: FlowValue | undefined,
): string {
	return String(renderTemplate(prompt, { variables, input }));
}
