export type FlowValue =
	| string
	| number
	| boolean
	| null
	| FlowValue[]
	| { [key: string]: FlowValue };

export type FlowVariableDeclaration = {
	description: string;
	default?: FlowValue;
};

export type FlowVariableDeclarations = Record<string, FlowVariableDeclaration>;

export type FlowVariables = Record<string, FlowValue>;

/** Explicit host profile selection for a new Agent session. */
export interface AgentProfileReference {
	id: string;
	params?: FlowVariables;
}

export type AgentActionKind = "新建Agent" | "复用Agent";

export interface AgentAction {
	kind: AgentActionKind;
	prompt: string;
	/** 新建Agent 标记后缀声明的平台执行器 id；派发时由宿主解析为已钉死的修订。 */
	executor?: string;
	profile?: AgentProfileReference;
}

export interface CommandRequest {
	command: string;
	args?: string[];
	stdin?: FlowValue;
	/** 命令 stdout 是否按变量结果信封解析。 */
	output?: "variables";
	/** 命令进程的工作目录；缺省时继承当前进程 cwd。 */
	cwd?: string;
}

export interface CommandAction {
	kind: "执行自定义命令";
	request: CommandRequest;
	branchReferences: string[];
}

/** 人工确认门禁：渲染提示文本后挂起，等待人在控制台选择一条结果边。 */
export interface ConfirmAction {
	kind: "confirm";
	/** 展示给决策人的提示正文，支持 {var.}/{input.} 模板。 */
	prompt: string;
}

export interface FlowReferenceAction {
	kind: "执行Flow";
	/** 目标 Flow 标识，即同目录下兄弟包的目录名。 */
	flow: string;
	/** 子 Flow 启动时显式传入的全局变量。 */
	inputs?: FlowVariables;
}

export type FlowAction =
	| AgentAction
	| CommandAction
	| ConfirmAction
	| FlowReferenceAction;

export interface FlowNode {
	ref: string;
	name: string;
	action: FlowAction;
	results: Map<string, string>;
	resultVariables?: Map<string, Record<string, { description: string }>>;
	successors: Map<string, FlowDestination>;
}

export type FlowDestination =
	| { kind: "node"; ref: string }
	| { kind: "parallel"; ref: string }
	| { kind: "finish" };

export interface ParallelStart {
	ref: string;
	branches: string[];
	joinRef: string;
}

export interface FlowDefinition {
	id: string;
	name: string;
	description: string;
	startNodeRef: string;
	nodes: Map<string, FlowNode>;
	parallels: Map<string, ParallelStart>;
	/** Flow 全局变量声明及默认值。 */
	variables?: FlowVariableDeclarations;
}

export interface TemplateContext {
	variables?: FlowVariables;
	input?: FlowVariables;
	branches?: ReadonlyMap<string, FlowVariables>;
}
