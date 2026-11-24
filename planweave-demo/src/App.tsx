import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, GitBranch, Moon, Network, Sun, X } from "lucide-react";
import { assignees, executorOptions, project, readDemoProjection, taskTitles } from "./demo-data";
import { browserProject, readGraph } from "./browser-project";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { createTranslator, type Language } from "./i18n";
import type { TaskCanvasRenameHandler } from "./renameResult";
import { CanvasMapView } from "./views/CanvasMapView";
import { TodoView } from "./views/TodoView";

type View = "map" | "todo";
type Preview = { canvasId: string; kind: "canvas" | "task" | "block" | "package"; id?: string };

function readRoute() {
  const [path, query] = location.hash.slice(1).split("?", 2);
  const params = new URLSearchParams(query);
  const canvasId = params.get("canvas");
  const kind = params.get("kind");
  const view: View = path === "/todo" ? "todo" : "map";
  const preview: Preview | null = canvasId && (kind === "canvas" || kind === "task" || kind === "block" || kind === "package")
    ? { canvasId, kind, id: params.get("id") ?? undefined } : null;
  return { view, preview };
}

function viewPath(view: View) { return view === "todo" ? "#/todo" : "#/map"; }

function PreviewDialog({ preview, graph, items, t, onClose, onOpen }: {
  preview: Preview;
  graph: ReturnType<typeof readGraph>;
  items: ReturnType<typeof readDemoProjection>["items"];
  t: ReturnType<typeof createTranslator>;
  onClose: () => void;
  onOpen: (next: Preview) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const canvas = graph.canvases.find((entry) => entry.canvasId === preview.canvasId);
  const scoped = items.filter((item) => item.canvasId === preview.canvasId);
  const block = scoped.find((item) => item.ref === preview.id);
  const taskItems = preview.kind === "task" ? scoped.filter((item) => item.taskId === preview.id) : scoped;
  const taskIds = [...new Set(taskItems.map(({ taskId }) => taskId))];
  const title = !canvas ? t("itemNotFound") : preview.kind === "package" ? t("packagePreview")
    : preview.kind === "task" ? taskTitles[taskIds[0]] ?? t("itemNotFound")
    : preview.kind === "block" ? block?.title ?? t("itemNotFound") : canvas.title;
  return <dialog ref={dialog} aria-labelledby="preview-title" onCancel={(event) => { event.preventDefault(); onClose(); }}
    className="m-auto max-h-[85dvh] w-[min(640px,calc(100vw-2rem))] rounded-md border border-border bg-app-panel text-text shadow-xl backdrop:bg-black/35">
    <header className="sticky top-0 z-10 flex min-w-0 items-start justify-between gap-2 border-b border-border bg-app-topbar p-4">
      <div className="min-w-0 [overflow-wrap:anywhere]"><p className="text-xs text-text-muted">{canvas?.title ?? project.name}</p><h2 id="preview-title" className="mt-1 font-semibold">{title}</h2></div>
      <Button size="icon-sm" variant="ghost" aria-label={t("close")} title={t("close")} onClick={onClose}><X /></Button>
    </header>
    <div className="space-y-3 p-4 text-sm">
      {canvas && preview.kind === "package" && <p className="rounded-md border bg-surface-muted p-3 font-mono text-xs break-all">{canvas.packageDir}</p>}
      {canvas && (preview.kind === "canvas" || preview.kind === "task") && (taskIds.length ? taskIds.map((taskId) =>
        <section key={taskId} className="rounded-md border border-border bg-surface-raised p-3">
          <h3 className="mb-2 font-medium">{taskTitles[taskId]}</h3>
          <ul className="space-y-1">{taskItems.filter((item) => item.taskId === taskId).map((item) =>
            <li key={item.ref}><button type="button" className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-sm px-2 py-1.5 text-left hover:bg-surface-muted" onClick={() => onOpen({ canvasId: canvas.canvasId, kind: "block", id: item.ref })}>
              <span>{item.title}</span><Badge variant="secondary">{item.status}</Badge>
            </button></li>)}</ul>
        </section>) : <p>{t("itemNotFound")}</p>)}
      {canvas && preview.kind === "block" && block && <>
        <code className="block break-all text-xs text-text-muted">{block.ref}</code>
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 rounded-md border border-border bg-surface-raised p-3">
          <dt>{t("status")}</dt><dd><Badge variant="secondary">{block.status}</Badge></dd>
          <dt>{t("dependencyBlockers")}</dt><dd className="break-all">{block.dependencyBlockers.join(", ") || t("noBlockers")}</dd>
          <dt>{t("dispatchability")}</dt><dd>{block.dispatchable ? t("dispatchable") : t("notDispatchable")}</dd>
          <dt>{t("sharedResources")}</dt><dd>{block.sharedResources.join(", ") || t("noSharedResources")}</dd>
          {block.reviewGate && <><dt>{t("reviewGate")}</dt><dd>{block.reviewGate.requiredReason}</dd></>}
        </dl>
      </>}
      {canvas && preview.kind !== "canvas" && <Button size="sm" variant="outline" onClick={() => onOpen({ canvasId: canvas.canvasId, kind: "canvas" })}>{t("enterCanvas")}</Button>}
    </div>
  </dialog>;
}

export function App() {
  const [route, setRoute] = useState(readRoute);
  const [graph, setGraph] = useState(readGraph);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const [language, setLanguage] = useState<Language>(() => navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
  const t = useMemo(() => createTranslator(language), [language]);
  const data = useMemo(() => readDemoProjection(graph), [graph]);

  useEffect(() => {
    const sync = () => setRoute(readRoute());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 2200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const refreshGraph = useCallback(() => setGraph(readGraph()), []);
  const openPreview = useCallback((preview: Preview) => {
    const { view } = readRoute();
    const params = new URLSearchParams({ canvas: preview.canvasId, kind: preview.kind });
    if (preview.id) params.set("id", preview.id);
    location.hash = `${viewPath(view)}?${params}`;
  }, []);
  const closePreview = useCallback(() => {
    history.replaceState(null, "", viewPath(readRoute().view));
    setRoute(readRoute());
  }, []);
  const openCanvas = useCallback((canvasId: string) => openPreview({ canvasId, kind: "canvas" }), [openPreview]);
  const openTask = useCallback((canvasId: string, id: string) => openPreview({ canvasId, kind: "task", id }), [openPreview]);
  const openBlock = useCallback(async (id: string, canvasId?: string | null) => {
    if (canvasId) openPreview({ canvasId, kind: "block", id });
  }, [openPreview]);
  const openPackage = useCallback(async (_project: typeof project, canvasId: string) => openPreview({ canvasId, kind: "package" }), [openPreview]);
  const promptCopied = useCallback(() => setFeedback(t("promptCopied")), [t]);
  const rename = useCallback<TaskCanvasRenameHandler>(async (_project, canvasId, title, request) => {
    if (!request.isCurrent()) return { status: "cancelled" };
    try {
      await browserProject.renameCanvas(canvasId, title);
      setError(null);
      refreshGraph();
      return { status: "saved" };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      return { status: "failed", error: message };
    }
  }, [refreshGraph]);

  return <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-app-shell text-text">
    <header className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border/80 bg-app-topbar px-3 py-1 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2"><Network className="size-4 shrink-0 text-text-muted" aria-hidden="true" /><span className="text-sm font-semibold">PlanWeave</span><span className="hidden truncate text-xs text-text-muted lg:inline">{project.name}</span></div>
      <nav aria-label={t("workViews")} className="order-last flex w-full items-center gap-1 sm:order-none sm:w-auto">
        {([["map", t("canvasMap"), GitBranch], ["todo", t("todo"), CircleCheck]] as const).map(([view, label, Icon]) =>
          <Button key={view} asChild size="sm" variant={route.view === view ? "secondary" : "ghost"}>
            <a href={viewPath(view)} aria-current={route.view === view ? "page" : undefined}><Icon className="size-4" aria-hidden="true" />{label}</a>
          </Button>)}
      </nav>
      <div className="flex items-center gap-1"><Badge className="hidden sm:inline-flex" variant="outline">{t("sampleData")}</Badge>
        <Button size="sm" variant="ghost" aria-label={language === "en" ? "切换至简体中文" : "Switch to English"} onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")}>{language === "en" ? "中文" : "EN"}</Button>
        <Button size="icon-sm" variant="ghost" title={dark ? t("lightTheme") : t("darkTheme")} aria-label={dark ? t("lightTheme") : t("darkTheme")}
          onClick={() => setDark((value) => !value)}>{dark ? <Sun /> : <Moon />}</Button>
      </div>
    </header>
    {error && <div role="alert" className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-1 text-sm"><span>{error}</span><Button size="icon-sm" variant="ghost" aria-label={t("close")} onClick={() => setError(null)}><X /></Button></div>}
    {feedback && <div role="status" className="pointer-events-none fixed bottom-4 left-4 z-30 rounded-md border bg-app-panel px-3 py-2 text-sm shadow-md">{feedback}</div>}
    <main className={`min-h-0 flex-1 bg-app-canvas ${route.view === "todo" ? "p-4" : ""}`}>
      {route.view === "todo" ? <TodoView t={t} assigneeIndex={assignees} todoGroups={data.todoGroups} executionPlan={data.executionPlan} handleBlockSelect={openBlock} />
        : <CanvasMapView dark={dark} executorOptions={executorOptions} packageExecutorNames={["reviewer"]} selectedProject={project} t={t}
            handleOpenBlockInspector={openBlock} handleRevealTaskCanvas={openPackage} handleRenameTaskCanvas={rename}
            onCanvasOpen={openCanvas} onTaskPanelSelect={openTask} onAgentPromptCopied={promptCopied} refreshProjectDerivedState={refreshGraph} setError={setError} />}
    </main>
    {route.preview && <PreviewDialog preview={route.preview} graph={graph} items={data.items} t={t} onClose={closePreview} onOpen={openPreview} />}
  </div>;
}
