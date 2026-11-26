import type { FlowExecutor } from "../contracts.ts";
import { FakeExecutor } from "./fake.ts";

/**
 * 一个可选的执行器适配器。宿主从这里取列表给用户选，
 * 按 id 建实例；新增执行器就是新增一个实现并登记一行。
 */
export interface ExecutorAdapter {
	id: string;
	title: string;
	description: string;
	create(): FlowExecutor;
}

/** 内置适配器清单。每次新建实例，避免运行之间共享执行器状态。 */
export const builtinExecutors: ExecutorAdapter[] = [
	{
		id: "fake",
		title: "Fake 执行器",
		description: "不接触模型与子进程：Agent 节点取第一条结果边，命令节点返回退出码 0。",
		create: () => new FakeExecutor(),
	},
];

export function findExecutor(
	id: string,
	adapters: ExecutorAdapter[] = builtinExecutors,
): ExecutorAdapter | undefined {
	return adapters.find((adapter) => adapter.id === id);
}
