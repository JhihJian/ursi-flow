"use client";

import { SystemPromptPanel } from "@/components/SystemPromptPanel";
import { ToolDefinitionsPanel } from "@/components/ToolDefinitionsPanel";
import { useI18n } from "@/hooks/useI18n";
import type { RuntimeInfo } from "@/lib/pi-session-api";

export function LiveRuntimePanel({ kind, runtime }: { kind: "system" | "tools"; runtime: RuntimeInfo }) {
  const { t } = useI18n();
  const heading = t(kind === "system" ? "system.prompt" : "tools.title");
  return (
    <section className="border-b border-border pb-3">
      <h2 className="mb-2 text-sm font-semibold">{heading}</h2>
      {kind === "system" ? (runtime.systemPrompt.trim() ?
        <SystemPromptPanel loading={false} prompt={runtime.systemPrompt} translate={t} /> :
        <p className="text-sm text-text-muted">{t("live.noSystemPrompt")}</p>) : (
        runtime.tools.some(tool => tool.active)
          ? <ToolDefinitionsPanel loading={false} tools={runtime.tools} translate={t} />
          : <p className="text-sm text-text-muted">{t("tools.noTools")}</p>
      )}
    </section>
  );
}

const settingsTitleKey = { models: "common.models", skills: "common.skills", mcp: "common.mcp" };
type RuntimeSettingsKind = keyof typeof settingsTitleKey;

export function LiveRuntimeSettings({ kind, runtime }: { kind: RuntimeSettingsKind; runtime: RuntimeInfo }) {
  const { t } = useI18n();
  return (
    <section className="border-b border-border pb-3">
      <h2 className="mb-2 text-sm font-semibold">{t(settingsTitleKey[kind])}</h2>
      <RuntimeContent kind={kind} runtime={runtime} />
    </section>
  );
}

function RuntimeContent({ kind, runtime }: { kind: RuntimeSettingsKind; runtime: RuntimeInfo }) {
  const { locale, t } = useI18n();
  const empty = (key: string) => <p className="text-sm text-text-muted">{t(key)}</p>;
  if (kind === "models") {
    const { model } = runtime;
    if (!model?.id.trim()) return empty("live.noModel");
    const number = new Intl.NumberFormat(locale);
    return (
      <dl className="grid gap-2 text-sm wrap-anywhere">
        {model.name && model.name !== model.id && <div><dt className="text-text-muted">{t("i18n.model")}</dt><dd>{model.name}</dd></div>}
        <div><dt className="text-text-muted">{t("live.modelId")}</dt><dd><code>{model.id}</code></dd></div>
        <div><dt className="text-text-muted">{t("i18n.provider")}</dt><dd>{model.provider}</dd></div>
        {typeof model.contextWindow === "number" && <div><dt className="text-text-muted">{t("models.contextWindow")}</dt><dd>{number.format(model.contextWindow)}</dd></div>}
        {typeof model.maxTokens === "number" && <div><dt className="text-text-muted">{t("models.maxOutputTokens")}</dt><dd>{number.format(model.maxTokens)}</dd></div>}
      </dl>
    );
  }
  if (kind === "skills") {
    if (runtime.skills.length === 0) return empty("live.noSkills");
    return <ul className="grid gap-2 text-sm wrap-anywhere">
      {runtime.skills.map(skill => <li key={skill.name}>
        <div className="font-medium">{skill.name}</div>
        {skill.description && <p className="whitespace-pre-wrap text-text-muted">{skill.description}</p>}
      </li>)}
    </ul>;
  }
  if (runtime.mcp.length === 0) return empty("live.noMcp");
  return <ul className="grid gap-2 text-sm wrap-anywhere">
    {runtime.mcp.map(({ name }) => <li key={name}><code>{name}</code></li>)}
  </ul>;
}
