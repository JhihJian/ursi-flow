export {
	ExecutorUnconfirmed,
	type CommandInvocation,
	type CommandOutput,
	type ExecutorReply,
	type FlowExecutor,
	type Instruct,
} from "./contracts.ts";
export { FakeExecutor } from "./adapters/fake.ts";
export { builtinExecutors, findExecutor } from "./adapters/index.ts";
export type { ExecutorAdapter } from "./adapters/index.ts";
export type {
	FakeCommand,
	FakeExecutorOptions,
	FakeReply,
} from "./adapters/fake.ts";
