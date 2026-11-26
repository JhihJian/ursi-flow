export {
	ExecutorUnconfirmed,
	type CommandInvocation,
	type CommandOutput,
	type ExecutorReply,
	type FlowExecutor,
	type Instruct,
} from "./contracts.ts";
export { FakeExecutor } from "./adapters/fake.ts";
export type {
	FakeCommand,
	FakeExecutorOptions,
	FakeReply,
} from "./adapters/fake.ts";
