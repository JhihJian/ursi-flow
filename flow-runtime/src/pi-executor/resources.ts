import { createExtensionRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { PiConfig } from './session.ts';

// Skills are immutable inline resources, not filesystem SKILL.md paths discoverable by Pi.
export function resources(config: PiConfig): ResourceLoader {
  const runtime = createExtensionRuntime();
  const skills = config.skills.map(s => `Skill ${JSON.stringify(s.id)} (revision ${s.revision})\n${s.content}` +
    (s.files?.length ? `\nFrozen companion files (use read_skill_file with this skill ID and one of these exact relative paths): ${JSON.stringify(s.files.map(f => f.path))}` : ''));
  return {
    getExtensions: () => ({ runtime, extensions: [], errors: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => config.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => skills,
    getAppendSystemPromptSources: () => [],
    extendResources() {}, async reload() {},
  };
}
