import type { FlowVariables } from "../../core/index.ts";
import type {
	CommandInvocation,
	CommandOutput,
	ExecutorReply,
	FlowExecutor,
	Instruct,
} from "../contracts.ts";

/** 一条脚本化回执。数组按同一节点的访问顺序消费。 */
export interface FakeReply {
	outcome: string;
	variables?: FlowVariables;
}

/** 一次脚本化命令结果。数组按同一节点的调用顺序消费。 */
export type FakeCommand = CommandOutput;

export interface FakeExecutorOptions {
	/** 按节点名（即执行器收到的 agentName）预设回执。 */
	replies?: Record<string, FakeReply[]>;
	/** 按节点名预设命令结果。 */
	commands?: Record<string, FakeCommand[]>;
	/** 没有预设时取第几条结果边：默认第一条。 */
	defaultOutcome?: "first" | "last";
	/** 没有预设的命令结果。缺省为退出码 0、空输出。 */
	defaultCommand?: FakeCommand;
	/** 没有预设回执时，为本节点声明的结果变量填占位值，默认开启。 */
	fillOutcomeVariables?: boolean;
	/** 同一运行内 prompt 调用上限，超过即抛错，避免默认取边把循环流程跑死。 */
	maxPrompts?: number;
}

/**
 * 不接触模型、子进程与网络的执行器：按预设脚本回答，或取第一条结果边。
 * 用于在没有真实执行器时走通 FLOW.md -> 结果，并让测试能断言引擎行为。
 */
export class FakeExecutor implements FlowExecutor {
	readonly prompts: Array<{ agentName: string; instruct: Instruct }> = [];
	readonly commands: CommandInvocation[] = [];
	private readonly replies: Record<string, FakeReply[]>;
	private readonly scripts: Record<string, FakeCommand[]>;
	private readonly options: FakeExecutorOptions;

	constructor(options: FakeExecutorOptions = {}) {
		this.options = options;
		this.replies = cloneQueues(options.replies);
		this.scripts = cloneQueues(options.commands);
	}

	async prompt(agentName: string, instruct: Instruct): Promise<ExecutorReply> {
		const limit = this.options.maxPrompts ?? 200;
		if (this.prompts.length >= limit)
			throw new Error(
				`FakeExecutor 已连续执行 ${limit} 个 Agent 节点仍未结束，检查流程是否成环或补预设回执`,
			);
		this.prompts.push({ agentName, instruct });
		const scripted = this.replies[agentName]?.shift();
		if (scripted !== undefined) return structuredClone(scripted);
		const options = instruct.outcomes;
		const picked = this.options.defaultOutcome === "last" ? options.at(-1) : options[0];
		if (picked === undefined)
			throw new Error(`节点 ${agentName} 没有可选结果边`);
		const variables = this.fill(agentName, picked, instruct);
		return variables === undefined
			? { outcome: picked.name }
			: { outcome: picked.name, variables };
	}

	/**
	 * 只填本节点结果自己声明的变量：全局变量由调用方提供，
	 * 否则占位值会覆盖启动变量。占位值的用途是让下一个节点能渲染。
	 */
	private fill(
		agentName: string,
		picked: { variables: Record<string, unknown> },
		instruct: Instruct,
	): FlowVariables | undefined {
		if (this.options.fillOutcomeVariables === false) return undefined;
		const declared = Object.keys(picked.variables).filter(
			(name) => !Object.hasOwn(instruct.variables, name),
		);
		if (declared.length === 0) return undefined;
		return Object.fromEntries(
			declared.map((name) => [name, `假执行器：${agentName}`]),
		);
	}

	async command(invocation: CommandInvocation): Promise<CommandOutput> {
		this.commands.push(invocation);
		const scripted = this.scripts[invocation.nodeName]?.shift();
		if (scripted !== undefined) return structuredClone(scripted);
		if (this.options.defaultCommand !== undefined)
			return structuredClone(this.options.defaultCommand);
		return {
			exitCode: 0,
			stdout: invocation.request.output === "variables" ? '{"variables":{}}' : "",
			stderr: "",
		};
	}
}

function cloneQueues<T>(
	source: Record<string, T[]> | undefined,
): Record<string, T[]> {
	return Object.fromEntries(
		Object.entries(source ?? {}).map(([key, queue]) => [
			key,
			structuredClone(queue),
		]),
	);
}
