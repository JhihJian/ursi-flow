import { normalizeAgentCapabilities } from "ursi-flow-core/engine";
import { validateAgentIdentity } from "ursi-flow-core/engine";
import type {
	AgentHarnessExtensions,
	AgentNodeExecutionRequest,
	AgentRunExecutor,
	FlowExecutionExtensions,
} from "ursi-flow-core/engine";
import type {
	AgentAssemblyIdentity,
	AgentAssemblyRequest,
	AgentCapabilityDeclaration,
	AgentHandle,
	AgentProfileReference,
	FlowAgentHarness,
	FlowDefinition,
	FlowPackage,
	NodeOutcome,
	NodeSession,
} from "ursi-flow-core/engine";
import { preflightFlow } from "ursi-flow-core/engine";
import { RuntimeOutcomeBridge } from "ursi-flow-core/engine";

type Binding = { agent: AgentHandle; bridge: RuntimeOutcomeBridge };
type Restoration = {
	takeOverNew: boolean;
	sessionReference: string;
	cwd?: string;
	assembly: AgentAssemblyRequest;
	expectedAssembly?: AgentAssemblyIdentity;
};

export interface AgentRunModelOptions {
	/** Observe the bridge that is currently accepting a node outcome. */
	onNodeBridgeChange?: (bridge: RuntimeOutcomeBridge | undefined) => void;
}

/** Run-scoped ownership; every visit gets a permanently separate tool bridge. */
export class AgentRunModel implements AgentRunExecutor {
	private readonly bindings = new Map<string, Binding>();
	private readonly restorations = new Map<string, Restoration>();
	private readonly sessions = new Map<string, string>();
	private readonly active = new Set<string>();
	private readonly closing = new Set<string>();
	private readonly operations = new Map<string, Promise<unknown>>();
	private readonly releases = new Map<string, Promise<void>>();
	private readonly endings = new Map<string, Promise<void>>();
	private readonly harness: FlowAgentHarness;
	private readonly options: AgentRunModelOptions;
	readonly extensions: AgentHarnessExtensions;

	constructor(
		harness: FlowAgentHarness,
		extensions: AgentHarnessExtensions = {},
		options: AgentRunModelOptions = {},
	) {
		this.harness = harness;
		this.extensions = extensions;
		this.options = options;
	}

	preflight(
		flow: FlowDefinition,
		options: {
			execution?: FlowExecutionExtensions;
			references?: ReadonlyMap<string, FlowPackage>;
			cwd?: string;
			sessionReference?: string;
		} = {},
	): Promise<void> {
		return preflightFlow(flow, { ...options, agent: this.extensions });
	}

	async start(
		runId: string,
		capabilities: AgentCapabilityDeclaration,
		existingAgentReference?: string,
		cwd?: string,
		expectedAssembly?: AgentAssemblyIdentity,
		expectedProfile?: AgentProfileReference,
		takeOverNew = true,
	): Promise<void> {
		if (
			this.bindings.has(runId) ||
			this.restorations.has(runId) ||
			this.active.has(runId) ||
			this.closing.has(runId)
		)
			throw new Error(`Flow 运行已绑定 Agent: ${runId}`);
		if (!existingAgentReference) return;
		if (!this.extensions.continuity)
			throw new Error("Flow 缺少扩展能力: Agent Continuity");
		this.claimSession(runId, existingAgentReference);
		this.restorations.set(runId, {
			takeOverNew,
			sessionReference: existingAgentReference,
			cwd,
			assembly: {
				capabilities: normalizeAgentCapabilities(capabilities),
				...(expectedProfile ? { profile: expectedProfile } : {}),
			},
			expectedAssembly,
		});
	}

	async executeNode(
		request: AgentNodeExecutionRequest,
	): Promise<{ outcome: NodeOutcome; session: NodeSession }> {
		if (this.active.has(request.runId) || this.closing.has(request.runId))
			throw new Error(
				`同一 Flow 运行不能并发执行或关闭 Agent: ${request.runId}`,
			);
		this.active.add(request.runId);
		const operation = this.execute(request);
		this.operations.set(request.runId, operation);
		try {
			return await operation;
		} finally {
			this.active.delete(request.runId);
			this.operations.delete(request.runId);
		}
	}

	private async execute(
		request: AgentNodeExecutionRequest,
	): Promise<{ outcome: NodeOutcome; session: NodeSession }> {
		const bridge = new RuntimeOutcomeBridge(
			request.nodeExecutionReference,
			request.outcomes,
			request.allowedVariables,
		);
		let binding = this.bindings.get(request.runId);
		try {
			this.options.onNodeBridgeChange?.(bridge);
			const restoration = this.restorations.get(request.runId);
			if (
				restoration &&
				(request.action === "复用Agent" || restoration.takeOverNew)
			) {
				const continuity = this.extensions.continuity;
				if (!continuity) throw new Error("Flow 缺少扩展能力: Agent Continuity");
				const assembly = {
					...restoration.assembly,
					...(request.profile ? { profile: request.profile } : {}),
				};
				const agent = await continuity.restore({
					runId: request.runId,
					cwd: restoration.cwd,
					runtimeTools: bridge,
					sessionReference: restoration.sessionReference,
					expectedAssembly: restoration.expectedAssembly,
					assembly,
				});
				try {
					validateAgentIdentity(agent, {
						sessionReference: restoration.sessionReference,
						assembly: restoration.expectedAssembly,
						profile: assembly.profile,
					});
				} catch (error) {
					await this.harness.close(agent);
					throw error;
				}
				binding = { agent, bridge };
				this.bindings.set(request.runId, binding);
				this.restorations.delete(request.runId);
			} else if (request.action === "新建Agent") {
				await this.release(request.runId);
				const assembly = {
					capabilities: normalizeAgentCapabilities(request.capabilities),
					...(request.profile ? { profile: request.profile } : {}),
				};
				const open = {
					runId: request.runId,
					cwd: request.cwd,
					runtimeTools: bridge,
				};
				const needsAssembly =
					request.profile ||
					assembly.capabilities.tools.length ||
					assembly.capabilities.skills.length;
				const assemblyExtension = this.extensions.assembly;
				if (needsAssembly && !assemblyExtension)
					throw new Error("Flow 缺少扩展能力: Agent Assembly");
				if (needsAssembly)
					await assemblyExtension?.preflight(assembly, request.cwd);
				const agent =
					needsAssembly && assemblyExtension
						? await assemblyExtension.open({ ...open, assembly })
						: await this.harness.open(open);
				try {
					validateAgentIdentity(agent, { profile: request.profile });
					this.claimSession(
						request.runId,
						agent.sessionReference ?? agent.platformReference,
					);
				} catch (error) {
					await this.harness.close(agent);
					throw error;
				}
				binding = { agent, bridge };
				this.bindings.set(request.runId, binding);
			} else {
				if (!this.extensions.continuity)
					throw new Error("Flow 缺少扩展能力: Agent Continuity");
				if (!binding) throw new Error("复用Agent前必须先新建或接管 Agent");
				binding.bridge.close();
				const identity = structuredClone(binding.agent);
				try {
					await this.extensions.continuity.rebind(binding.agent, bridge);
					validateAgentIdentity(binding.agent, {
						sessionReference: identity.sessionReference,
						assembly: identity.assembly,
					});
					if (
						binding.agent.id !== identity.id ||
						binding.agent.platformReference !== identity.platformReference
					)
						throw new Error("Agent 复用改变了会话身份");
				} catch (error) {
					binding.agent = identity;
					throw error;
				}
				binding.bridge = bridge;
			}
			if (!binding) throw new Error("Agent 绑定不存在");
			if (this.closing.has(request.runId)) throw new Error("Agent 已请求关闭");
			await request.onConnection?.(binding.agent);
			const state = await this.harness.run(binding.agent, {
				executionId: request.nodeExecutionReference,
				prompt: request.prompt,
			});
			if (this.closing.has(request.runId)) throw new Error("Agent 已请求关闭");
			if (state.status !== "completed")
				throw new Error(
					state.error?.summary ?? `Agent 节点执行${state.status}`,
				);
			if (state.session && !state.session.id?.trim())
				throw new Error("Agent 返回了无效消息证据身份");
			if (
				state.session?.sessionReference &&
				binding.agent.sessionReference &&
				state.session.sessionReference !== binding.agent.sessionReference
			)
				throw new Error("Agent 消息证据不属于当前 Session");
			const outcome = bridge.outcome;
			if (!outcome) throw new Error("Agent 节点结束前必须通过结果工具提交结果");
			return {
				outcome,
				session: state.session ?? {
					id: request.nodeExecutionReference,
					sessionReference: binding.agent.sessionReference,
				},
			};
		} catch (error) {
			await this.release(request.runId);
			throw error;
		} finally {
			bridge.close();
			this.options.onNodeBridgeChange?.(undefined);
		}
	}

	private claimSession(runId: string, reference: string): void {
		const owner = this.sessions.get(reference);
		if (owner && owner !== runId)
			throw new Error(`Agent 已绑定到另一个 Flow 运行: ${reference}`);
		this.sessions.set(reference, runId);
	}

	private async release(runId: string): Promise<void> {
		const pending = this.releases.get(runId);
		if (pending) return pending;
		const binding = this.bindings.get(runId);
		this.bindings.delete(runId);
		this.restorations.delete(runId);
		binding?.bridge.close();
		const operation = Promise.resolve().then(async () => {
			try {
				if (binding) await this.harness.close(binding.agent);
			} finally {
				for (const [reference, owner] of this.sessions)
					if (owner === runId) this.sessions.delete(reference);
			}
		});
		this.releases.set(runId, operation);
		try {
			await operation;
		} finally {
			this.releases.delete(runId);
		}
	}

	async end(runId: string): Promise<void> {
		const pending = this.endings.get(runId);
		if (pending) return pending;
		this.closing.add(runId);
		const operation = this.finish(runId);
		this.endings.set(runId, operation);
		try {
			await operation;
		} finally {
			this.endings.delete(runId);
			this.closing.delete(runId);
		}
	}

	private async finish(runId: string): Promise<void> {
		await this.release(runId);
		await this.operations.get(runId)?.catch(() => undefined);
		await this.release(runId);
	}
}
