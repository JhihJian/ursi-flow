import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Moon, Sun, X } from "lucide-react";
import { assignees, executorOptions, project, readDemoProjection } from "./demo-data";
import { browserProject, readGraph } from "./browser-project";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { createTranslator, type Language } from "./i18n";
import type { TaskCanvasRenameHandler } from "./renameResult";
import { CanvasMapView } from "./views/CanvasMapView";
import { TodoView } from "./views/TodoView";
import { TaskGraphView } from "./views/TaskGraphView";
import { WorkspaceChrome } from "./WorkspaceChrome";

type Preview = { canvasId: string; kind: "block" | "package"; id?: string };
type LocationView = { view: "map" | "todo" } | { view: "graph"; canvasId: string; taskId: string | null };

function readRoute() {
  const [path, query] = location.hash.slice(1).split("?", 2);
  const params = new URLSearchParams(query);
  const canvasId = params.get("canvas");
  const kind = params.get("kind");
  const view: LocationView = path === "/graph" && canvasId
    ? { view: "graph", canvasId, taskId: params.get("task") }
    : { view: path === "/todo" ? "todo" : "map" };
  const detailCanvasId = params.get("detailCanvas") ?? canvasId;
  const preview: Preview | null = detailCanvasId && (kind === "block" || kind === "package")
    ? { canvasId: detailCanvasId, kind, id: params.get("id") ?? undefined } : null;
  return { view, preview };
}

function viewPath(view: LocationView, preview?: Preview) {
  const params = new URLSearchParams();
  if (view.view === "graph") {
    params.set("canvas", view.canvasId);
    if (view.taskId) params.set("task", view.taskId);
  }
  if (preview) {
    params.set(view.view === "graph" ? "detailCanvas" : "canvas", preview.canvasId);
    params.set("kind", preview.kind);
    if (preview.id) params.set("id", preview.id);
  }
  return `#/${view.view}${params.size ? `?${params}` : ""}`;
}

function PreviewDialog({ preview, graph, items, t, onClose, onCanvasOpen }: {
  preview: Preview;
  graph: ReturnType<typeof readGraph>;
  items: ReturnType<typeof readDemoProjection>["items"];
  t: ReturnType<typeof createTranslator>;
  onClose: () => void;
  onCanvasOpen: (canvasId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const canvas = graph.canvases.find((entry) => entry.canvasId === preview.canvasId);
  const block = items.find((item) => item.canvasId === preview.canvasId && item.ref === preview.id);
  const title = !canvas ? t("itemNotFound") : preview.kind === "package" ? t("packagePreview")
    : block?.title ?? t("itemNotFound");
  return <dialog ref={dialog} aria-labelledby="preview-title" onCancel={(event) => { event.preventDefault(); onClose(); }}
    className="m-auto max-h-[85dvh] w-[min(640px,calc(100vw-2rem))] rounded-md border border-border bg-app-panel text-text shadow-xl backdrop:bg-black/35">
    <header className="sticky top-0 z-10 flex min-w-0 items-start justify-between gap-2 border-b border-border bg-app-topbar p-4">
      <div className="min-w-0 [overflow-wrap:anywhere]"><p className="text-xs text-text-muted">{canvas?.title ?? project.name}</p><h2 id="preview-title" className="mt-1 font-semibold">{title}</h2></div>
      <Button size="icon-sm" variant="ghost" aria-label={t("close")} title={t("close")} onClick={onClose}><X /></Button>
    </header>
    <div className="space-y-3 p-4 text-sm">
      {canvas && preview.kind === "package" && <p className="rounded-md border bg-surface-muted p-3 font-mono text-xs break-all">{canvas.packageDir}</p>}
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
      {canvas && <Button size="sm" variant="outline" onClick={() => onCanvasOpen(canvas.canvasId)}>{t("enterCanvas")}</Button>}
    </div>
  </dialog>;
}

export function App() {
  const [route, setRoute] = useState(readRoute);
  const [focusRevision, refocus] = useState(0);
  const [graph, setGraph] = useState(readGraph);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const [language, setLanguage] = useState<Language>(() => navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
  const t = useMemo(() => createTranslator(language), [language]);
  const data = useMemo(() => readDemoProjection(graph), [graph]);
  const canvasId = route.view.view === "graph" ? route.view.canvasId : null;
  const taskId = route.view.view === "graph" ? route.view.taskId : null;
  const activeCanvas = graph.canvases.find((canvas) => canvas.canvasId === canvasId);
  const selectedTaskId = data.items.some((item) => item.canvasId === canvasId && item.taskId === taskId) ? taskId : null;
  const view = route.view.view === "graph" && !activeCanvas ? "map" : route.view.view;

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
    location.hash = viewPath(readRoute().view, preview);
  }, []);
  const closePreview = useCallback(() => {
    history.replaceState(null, "", viewPath(readRoute().view));
    setRoute(readRoute());
  }, []);
  const openCanvas = useCallback((canvasId: string) => {
    location.hash = viewPath({ view: "graph", canvasId, taskId: null });
  }, []);
  const openTask = useCallback((canvasId: string, taskId: string) => {
    const hash = viewPath({ view: "graph", canvasId, taskId });
    if (location.hash === hash) refocus((value) => value + 1);
    else location.hash = hash;
  }, []);
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

  return <div className="glass-surface flex h-dvh min-h-0 flex-col overflow-hidden text-text">
    <WorkspaceChrome view={view} canvases={graph.canvases} items={data.items}
      activeCanvasId={activeCanvas?.canvasId ?? project.activeCanvasId} selectedTaskId={selectedTaskId}
      onCanvasOpen={openCanvas} onTaskOpen={openTask} t={t}
      titlebarActions={<>
        <Button size="sm" variant="ghost" aria-label={language === "en" ? "切换至简体中文" : "Switch to English"} onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")}>{language === "en" ? "中文" : "EN"}</Button>
        <Button size="icon-sm" variant="ghost" title={dark ? t("lightTheme") : t("darkTheme")} aria-label={dark ? t("lightTheme") : t("darkTheme")}
          onClick={() => setDark((value) => !value)}>{dark ? <Sun /> : <Moon />}</Button>
      </>}>
      {view === "graph" && activeCanvas ? <TaskGraphView key={activeCanvas.canvasId} canvas={activeCanvas} items={data.items}
          selectedTaskId={selectedTaskId} focusRevision={focusRevision} dark={dark} onTaskSelect={openTask} onBlockOpen={openBlock} t={t} />
        : view === "todo" ? <TodoView t={t} assigneeIndex={assignees} todoGroups={data.todoGroups} executionPlan={data.executionPlan} handleBlockSelect={openBlock} />
        : <CanvasMapView dark={dark} executorOptions={executorOptions} packageExecutorNames={["reviewer"]} selectedProject={project} t={t}
            handleOpenBlockInspector={openBlock} handleRevealTaskCanvas={openPackage} handleRenameTaskCanvas={rename}
            onCanvasOpen={openCanvas} onTaskPanelSelect={openTask} onAgentPromptCopied={promptCopied} refreshProjectDerivedState={refreshGraph} setError={setError} />}
    </WorkspaceChrome>
    {error && <div role="alert" className="flex shrink-0 items-center justify-between gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-1 text-sm"><span>{error}</span><Button size="icon-sm" variant="ghost" aria-label={t("close")} onClick={() => setError(null)}><X /></Button></div>}
    {feedback && <div role="status" className="pointer-events-none fixed bottom-4 left-4 z-30 rounded-md border bg-app-panel px-3 py-2 text-sm shadow-md">{feedback}</div>}
    {route.preview && <PreviewDialog preview={route.preview} graph={graph} items={data.items} t={t} onClose={closePreview} onCanvasOpen={openCanvas} />}
  </div>;
}
