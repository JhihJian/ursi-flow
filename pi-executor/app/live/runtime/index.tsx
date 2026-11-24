"use client";

import { SystemPromptPanel } from "@/components/SystemPromptPanel";
import { ToolDefinitionsPanel } from "@/components/ToolDefinitionsPanel";
import { useI18n } from "@/hooks/useI18n";
import type { RuntimeInfo } from "../api";

interface RuntimeProps {
  runtime: RuntimeInfo | null;
  error: string | null;
}

const scopeKey = (scope: RuntimeInfo["scope"]) => (
  scope === "session" ? "live.sessionRuntimeInfo" : "live.runtimeInfo"
);

function RuntimeLoadState({ error }: { error: string | null }) {
  const { t } = useI18n();
  if (error === null) {
    return <p role="status" className="text-xs text-text-muted">{t("live.runtimeLoading")}</p>;
  }
  return (
    <p role="alert" className="settings-general-error wrap-anywhere">
      {t("live.runtimeLoadError")}
      {error && <span className="mt-1 block">{error}</span>}
    </p>
  );
}

export function LiveRuntimePanel({ kind, runtime, error }: RuntimeProps & { kind: "system" | "tools" }) {
  const { t } = useI18n();
  const label = t(kind === "system" ? "system.prompt" : "tools.title");

  if (error !== null || !runtime) {
    return (
      <section aria-label={label} className="border-b border-border bg-bg-panel px-4 py-3">
        <RuntimeLoadState error={error} />
      </section>
    );
  }

  const empty = kind === "system" ? !runtime.systemPrompt.trim() : !runtime.tools.some((tool) => tool.active);
  return (
    <div>
      <p className="border-b border-border bg-bg-panel px-4 py-2 text-xs text-text-muted">
        {t(scopeKey(runtime.scope))}
      </p>
      {empty ? (
        <section aria-label={label} className="border-b border-border bg-bg-panel px-4 py-3 text-xs text-text-muted">
          <p role="status">{t(kind === "system" ? "live.noSystemPrompt" : "tools.noTools")}</p>
        </section>
      ) : kind === "system" ? (
        <SystemPromptPanel loading={false} prompt={runtime.systemPrompt} translate={t} />
      ) : (
        <ToolDefinitionsPanel loading={false} tools={runtime.tools} translate={t} />
      )}
    </div>
  );
}

const settingsTitleKey = {
  models: "common.models",
  skills: "common.skills",
  mcp: "common.mcp",
};

type RuntimeSettingsKind = keyof typeof settingsTitleKey;

function RuntimeSettingsContent({ kind, runtime }: { kind: RuntimeSettingsKind; runtime: RuntimeInfo }) {
  const { locale, t } = useI18n();
  const empty = (key: string) => <p role="status" className="settings-general-description">{t(key)}</p>;

  if (kind === "models") {
    const { model } = runtime;
    if (!model?.id.trim()) return empty("live.noModel");
    const number = new Intl.NumberFormat(locale);
    return (
      <dl className="grid gap-2 text-sm wrap-anywhere">
        <div><dt className="text-text-muted">{t("i18n.model")}</dt><dd>{model.name || model.id}</dd></div>
        <div><dt className="text-text-muted">{t("live.modelId")}</dt><dd><code>{model.id}</code></dd></div>
        <div><dt className="text-text-muted">{t("i18n.provider")}</dt><dd>{model.provider}</dd></div>
        {typeof model.contextWindow === "number" && <div><dt className="text-text-muted">{t("models.contextWindow")}</dt><dd>{number.format(model.contextWindow)}</dd></div>}
        {typeof model.maxTokens === "number" && <div><dt className="text-text-muted">{t("models.maxOutputTokens")}</dt><dd>{number.format(model.maxTokens)}</dd></div>}
      </dl>
    );
  }

  if (kind === "skills") {
    if (runtime.skills.length === 0) return empty("live.noSkills");
    return (
      <ul className="grid gap-2 text-sm wrap-anywhere">
        {runtime.skills.map((skill) => (
          <li key={skill.name}>
            <div className="font-medium">{skill.name}</div>
            {skill.description && <p className="whitespace-pre-wrap text-text-muted">{skill.description}</p>}
          </li>
        ))}
      </ul>
    );
  }

  if (runtime.mcp.length === 0) return empty("live.noMcp");
  return (
    <ul className="grid gap-2 text-sm wrap-anywhere">
      {runtime.mcp.map(({ name }) => <li key={name}><code>{name}</code></li>)}
    </ul>
  );
}

export function LiveRuntimeSettings({ kind, runtime, error }: RuntimeProps & { kind: RuntimeSettingsKind }) {
  const { t } = useI18n();
  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t(settingsTitleKey[kind])}</h2>
      <section className="settings-general-section">
        {error !== null || !runtime ? (
          <RuntimeLoadState error={error} />
        ) : (
          <>
            <p className="settings-general-description">{t(scopeKey(runtime.scope))}</p>
            <RuntimeSettingsContent kind={kind} runtime={runtime} />
          </>
        )}
      </section>
    </div>
  );
}
