import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	AgentConnection,
	AgentHandle,
	AgentTurnState,
	CommandExecutor,
	CommandRequest,
	CommandResult,
	NodeOutcome,
	NodeSession,
	UnifiedMessage,
} from "../src/core/contracts/types.ts";
import { parseFlow } from "../src/core/definition/parser.ts";
import { InMemoryRunStore } from "../src/core/state/memory-store.ts";
import {
	createTestAgentModel,
	createTestCoordinator,
	TestHarness,
	type TestOpenRequest,
	type TestRestoreRequest,
	type TestTurnRequest,
} from "./helpers/harness.ts";

const fixture = (name: string) =>
	readFile(join(import.meta.dirname, "fixtures", name, "FLOW.md"), "utf8");

class FakeAdapter extends TestHarness {
	readonly executed: string[] = [];
	readonly released: string[] = [];
	readonly created: string[] = [];
	readonly takenOver: string[] = [];
	readonly sessions = new Map<string, UnifiedMessage[]>();
	private readonly outcomes: NodeOutcome[];

	constructor(outcomes: NodeOutcome[]) {
		super();
		this.outcomes = outcomes;
	}

	async create(request: TestOpenRequest): Promise<AgentHandle> {
		this.created.push(request.runId);
		return {
			id: `${request.runId}:agent`,
			platformReference: `${request.runId}:agent`,
			sessionReference: "fake-session",
		};
	}

	async restore(request: TestRestoreRequest): Promise<AgentHandle> {
		this.takenOver.push(request.sessionReference);
		return {
			id: "taken-over",
			platformReference: request.sessionReference,
			sessionReference: request.sessionReference,
		};
	}

	async run(
		agent: AgentHandle,
		request: TestTurnRequest,
	): Promise<AgentTurnState> {
		const next = this.outcomes.shift();
		if (!next) throw new Error("Fake Agent 缺少预设结果");
		this.executed.push(request.executionId);
		await this.bridgeFor(agent).invoke({
			toolName: "submit_flow_outcome",
			arguments: {
				outcome: next.result,
				...(next.variables === undefined ? {} : { variables: next.variables }),
			},
		});
		const session = {
			id: request.executionId,
			sessionReference: agent.sessionReference,
			interactionReference: request.executionId,
		};
		this.sessions.set(session.id, [
			{
				id: request.executionId,
				role: "assistant",
				content: request.prompt,
			},
		]);
		return { status: "completed", session: session };
	}

	async getNodeSession(session: NodeSession): Promise<UnifiedMessage[]> {
		return this.sessions.get(session.id) ?? [];
	}

	async release(connection: AgentConnection): Promise<void> {
		this.released.push(connection.id);
	}
}

class FakeCommandExecutor implements CommandExecutor {
	readonly requests: CommandRequest[] = [];
	async execute(request: CommandRequest): Promise<CommandResult> {
		this.requests.push(request);
		return {
			status: "success",
			exitCode: 0,
			stdout: JSON.stringify({
				variables:
					request.command === "merge"
						? { 汇总结果: "merged" }
						: { 摘要: request.command },
			}),
			stderr: "",
		};
	}
}

describe("FlowCoordinator", () => {
	it("runs ordinary Agent nodes and stores independent records", async () => {
		const adapter = new FakeAdapter([
			{ result: "已分析", variables: { 分析结论: "analysis" } },
			{ result: "已完成" },
		]);
		const store = new InMemoryRunStore();
		const flow = parseFlow(await fixture("ordinary"), "ordinary");
		const result = await createTestCoordinator(
			flow,
			store,
			createTestAgentModel(adapter),
		).run({ variables: { 任务: "task" } });
		expect(result.status).toBe("completed");
		const records = await store.listNodeRuns(result.id);
		expect(records).toHaveLength(2);
		expect(records.map((record) => record.nodeName)).toEqual([
			"分析任务",
			"完成任务",
		]);
		expect(records.map((record) => record.input)).toEqual([
			{},
			{ 分析结论: "analysis" },
		]);
		expect(adapter.released).toHaveLength(1);
	});

	it("runs a gate loop as distinct visits", async () => {
		const adapter = new FakeAdapter([{ result: "返工" }, { result: "通过" }]);
		const store = new InMemoryRunStore();
		const flow = parseFlow(await fixture("gate-loop"), "gate-loop");
		const result = await createTestCoordinator(
			flow,
			store,
			createTestAgentModel(adapter),
		).run({ variables: { 任务: "task" } });
		const records = await store.listNodeRuns(result.id);
		expect(records.map((record) => record.nodeRef)).toEqual([
			"review",
			"review",
		]);
		expect(records[1].input).toEqual({});
	});

	it("resumes an interrupted new-agent node in its persisted Pi session", async () => {
		const adapter = new FakeAdapter([
			{ result: "已分析", variables: { 分析结论: "analysis" } },
			{ result: "已完成" },
		]);
		const store = new InMemoryRunStore();
		const flow = parseFlow(await fixture("ordinary"), "ordinary");
		await store.createRun({
			id: "interrupted-run",
			flowId: flow.id,
			flowVersion: "legacy:unknown",
			variables: { 任务: "task" },
			status: "running",
			phase: "executing_node",
			sequence: 1,
			historyCompleteness: "legacy",
			startedAt: "2026-01-01T00:00:00.000Z",
			flowPath: "/flows/ordinary/FLOW.md",
			cwd: "/work",
			sessionReference: "saved-pi-session",
			currentNodeRef: "analyze",
			currentInput: {},
		});
		await store.createNodeRun({
			id: "interrupted-node",
			runId: "interrupted-run",
			sequence: 2,
			nodeRef: "analyze",
			actionKind: "新建Agent",
			input: {},
			status: "running",
			startedAt: "2026-01-01T00:01:00.000Z",
			enteredFrom: { kind: "start" },
		});

		const result = await createTestCoordinator(
			flow,
			store,
			createTestAgentModel(adapter),
		).resume("interrupted-run", { cwd: "/work" });

		expect(result.status).toBe("completed");
		expect(adapter.takenOver).toEqual(["saved-pi-session"]);
		expect(adapter.created).toEqual([]);
		expect(await store.listRunningRuns()).toEqual([]);
		expect(await store.listNodeRuns(result.id)).toHaveLength(3);
	});

	it("runs command branches in parallel and gives the join this round's outcomes", async () => {
		const adapter = new FakeAdapter([
			{ result: "执行检查", variables: { 检查上下文: "check task" } },
			{ result: "通过" },
		]);
		const commands = new FakeCommandExecutor();
		const store = new InMemoryRunStore();
		const flow = parseFlow(
			await fixture("command-parallel"),
			"command-parallel",
		);
		const result = await createTestCoordinator(
			flow,
			store,
			createTestAgentModel(adapter),
			commands,
		).run({ variables: { 任务: "task" } });
		expect(result.status).toBe("completed");
		expect(commands.requests.map((request) => request.command)).toEqual(
			expect.arrayContaining(["test", "lint", "merge"]),
		);
		const merge = commands.requests.find(
			(request) => request.command === "merge",
		);
		expect(merge).toBeDefined();
		if (!merge) throw new Error("expected merge command");
		expect(merge.stdin).toMatchObject({
			test: "test",
			lint: "lint",
		});
		expect(
			(await store.listNodeRuns(result.id)).map((record) => record.nodeRef),
		).toEqual(
			expect.arrayContaining(["plan", "test", "lint", "merge", "judge"]),
		);
	});
});
