import type {
	CommandRequest,
	FlowVariables,
	OutcomeOption,
} from "../core/index.ts";

/** 一次 Agent 调用的输入。执行器只需按 text 工作，其余字段用于回执校验与审计。 */
export interface Instruct {
	runId: string;
	stepId: string;
	nodeRef: string;
	/** 本次 Run 内第几次进入该节点，从 1 开始。 */
	visit: number;
	/** 已渲染的提示词正文。 */
	text: string;
	/** 本步允许提交的结果与说明，来自 Flow 定义的结果边。 */
	outcomes: OutcomeOption[];
	/** 当前全局变量。 */
	variables: FlowVariables;
	cwd?: string;
	/** 上一次提交被拒的原因；首次调用时为 undefined。 */
	rejection?: string;
}

/** 执行器回到引擎的结果。outcome 必须是 Instruct.outcomes 中的名字。 */
export interface ExecutorReply {
	outcome: string;
	variables?: FlowVariables;
}

/** 执行器无法确认本次访问的结果：Run 进入待核实，`resume` 只核实原尝试。 */
export class ExecutorUnconfirmed extends Error {}

/** 一次命令执行。request 已按变量与分支结果渲染完成。 */
export interface CommandInvocation {
	runId: string;
	stepId: string;
	nodeRef: string;
	nodeName: string;
	request: CommandRequest;
	cwd?: string;
}

/** 命令执行证据。退出码不为 0 仍按“已执行”路由，由流程自行判断。 */
export interface CommandOutput {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * 执行器唯一对外契约。引擎只通过这两个方法接触外部世界：
 * `prompt` 执行一个 Agent 节点，`command` 执行一个命令节点。
 * 会话复用、模型、凭据、子进程与超时都归实现方，不进入契约。
 */
export interface FlowExecutor {
	/** 执行器标识。运行头记录它，恢复时要求一致，避免旧运行被别的执行器接着跑。 */
	readonly id: string;
	prompt(agentName: string, instruct: Instruct): Promise<ExecutorReply>;
	command(invocation: CommandInvocation): Promise<CommandOutput>;
}
