import type {
	AgentAssemblyIdentity,
	AgentHandle,
	AgentProfileReference,
} from "./types.ts";

const ASSEMBLY_FIELDS = [
	"hostId",
	"pluginId",
	"pluginVersion",
	"pluginDigest",
	"profileId",
	"paramsDigest",
] as const;

/** Validate host identities without interpreting provider or model configuration. */
export function validateAgentIdentity(
	agent: AgentHandle,
	expected: {
		sessionReference?: string;
		assembly?: AgentAssemblyIdentity;
		profile?: AgentProfileReference;
	} = {},
): void {
	if (
		!agent ||
		typeof agent.id !== "string" ||
		!agent.id.trim() ||
		typeof agent.platformReference !== "string" ||
		!agent.platformReference.trim()
	)
		throw new Error("Agent 必须返回非空连接身份");
	if (
		expected.sessionReference &&
		agent.sessionReference !== expected.sessionReference
	)
		throw new Error("Agent 恢复的 Session 身份不匹配");
	const actual = agent.assembly;
	if (!actual) {
		if (expected.assembly || expected.profile)
			throw new Error("Agent 未返回可验证的 Profile 装配身份");
		return;
	}
	for (const field of ASSEMBLY_FIELDS) {
		if (typeof actual[field] !== "string" || !actual[field].trim())
			throw new Error(`Agent Profile 装配身份缺少字段: ${field}`);
		if (expected.assembly && actual[field] !== expected.assembly[field])
			throw new Error(`Agent Profile 装配身份不匹配: ${field}`);
	}
	if (expected.profile && actual.profileId !== expected.profile.id)
		throw new Error("Agent Profile 装配身份不匹配: profileId");
}
