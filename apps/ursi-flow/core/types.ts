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

/** 新建一次 Agent 会话。会话复用由宿主按节点名决定，不在 Flow 里声明。 */
export interface AgentAction {
	kind: "新建Agent";
	prompt: string;
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

/** 人工确认门禁：渲染提示文本后挂起，等待人选一条结果边。 */
export interface ConfirmAction {
	kind: "confirm";
	/** 展示给决策人的提示正文，支持 {var.}/{input.} 模板。 */
	prompt: string;
}

export type FlowAction = AgentAction | CommandAction | ConfirmAction;

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

/** 并行开始点：两条以上命令分支，共同汇合到一个命令节点。 */
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
