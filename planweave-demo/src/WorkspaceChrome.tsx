import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronRightIcon, ComponentIcon, GitBranchIcon, ListTodoIcon, NetworkIcon,
  PanelLeftCloseIcon, PanelLeftOpenIcon, PanelRightCloseIcon, PanelRightOpenIcon, WorkflowIcon
} from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { ScrollArea } from "./components/ui/scroll-area";
import { demoTasks, project, taskTitles } from "./demo-data";
import type { createTranslator } from "./i18n";
import type { DesktopCanvasNodeViewModel } from "./model";

type View = "map" | "todo" | "graph";
type Translator = ReturnType<typeof createTranslator>;

const selectedStyle = "data-[variant=secondary]:border-state-selected/25 data-[variant=secondary]:bg-state-selected-surface data-[variant=secondary]:text-text-strong data-[variant=secondary]:shadow-sm";
const navStyle = `h-8 justify-start rounded-md px-2 text-text-muted hover:bg-surface-muted hover:text-text-strong [&_svg]:size-4 ${selectedStyle}`;
const treeRow = "grid w-full min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-1";

function SidebarToggle({ expanded, side, onClick, t }: {
  expanded: boolean; side: "left" | "right"; onClick: () => void; t: Translator;
}) {
  const Icon = side === "left"
    ? (expanded ? PanelLeftCloseIcon : PanelLeftOpenIcon)
    : (expanded ? PanelRightCloseIcon : PanelRightOpenIcon);
  const label = side === "left"
    ? t(expanded ? "collapseSidebar" : "expandSidebar")
    : t(expanded ? "collapseComponents" : "expandComponents");
  return <Button size="icon-sm" variant="ghost" aria-controls={side === "left" ? "project-sidebar" : "component-palette"}
    aria-expanded={expanded} aria-label={label} title={label} onClick={onClick}><Icon /></Button>;
}

function TreeToggle({ expanded, name, onClick }: { expanded: boolean; name: string; onClick: () => void }) {
  return <Button size="icon-sm" variant="ghost" className="size-7 text-text-faint hover:bg-surface-muted hover:text-text-strong"
    aria-expanded={expanded} aria-label={name} onClick={onClick}>
    <ChevronRightIcon className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
  </Button>;
}

type WorkspaceChromeProps = {
  view: View;
  canvases: DesktopCanvasNodeViewModel[];
  activeCanvasId: string;
  selectedTaskId: string | null;
  titlebarActions: ReactNode;
  onCanvasOpen: (canvasId: string) => void;
  onTaskOpen: (canvasId: string, taskId: string) => void;
  t: Translator;
  children: ReactNode;
};

export function WorkspaceChrome({ view, canvases, activeCanvasId, selectedTaskId, titlebarActions, onCanvasOpen, onTaskOpen, t, children }: WorkspaceChromeProps) {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"projects" | "components" | null>(null);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const [expandedCanvases, setExpandedCanvases] = useState(() => new Set([project.activeCanvasId]));
  const closeMobile = () => setMobilePanel(null);
  const showPalette = view !== "map";
  useEffect(() => {
    if (view !== "graph") return;
    setProjectExpanded(true);
    setExpandedCanvases((current) => current.has(activeCanvasId) ? current : new Set([...current, activeCanvasId]));
  }, [activeCanvasId, selectedTaskId, view]);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" onKeyDown={(event) => { if (event.key === "Escape") closeMobile(); }}>
      {mobilePanel && <div aria-hidden="true" className="absolute inset-0 z-20 bg-black/25 min-[1100px]:hidden" onClick={closeMobile} />}
      <aside id="project-sidebar" data-testid="project-sidebar" aria-label={t("projects")}
        className={`absolute inset-y-0 left-0 z-30 w-[min(280px,100vw)] shrink-0 flex-col overflow-hidden bg-app-sidebar text-text min-[1100px]:static min-[1100px]:z-auto min-[1100px]:w-[280px] ${mobilePanel === "projects" ? "flex" : "hidden"} ${leftCollapsed ? "min-[1100px]:hidden" : "min-[1100px]:flex"}`}>
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border/80 px-3">
          <span className="hidden min-[1100px]:inline-flex"><SidebarToggle expanded side="left" t={t} onClick={() => setLeftCollapsed(true)} /></span>
          <span className="inline-flex min-[1100px]:hidden"><SidebarToggle expanded side="left" t={t} onClick={closeMobile} /></span>
          <span className="ml-1 text-sm font-semibold">PlanWeave</span>
        </header>
        <nav aria-label={t("workViews")} className="flex flex-col gap-1 border-b border-border/60 p-3 pt-2">
          <Button asChild className={navStyle} variant={view === "map" ? "secondary" : "ghost"}>
            <a href="#/map" aria-current={view === "map" ? "page" : undefined} onClick={closeMobile}><NetworkIcon data-icon="inline-start" />{t("canvasMap")}</a>
          </Button>
          <Button asChild className={navStyle} variant={view === "todo" ? "secondary" : "ghost"}>
            <a href="#/todo" aria-current={view === "todo" ? "page" : undefined} onClick={closeMobile}><ListTodoIcon data-icon="inline-start" />{t("todo")}</a>
          </Button>
        </nav>
        <section className="flex min-h-0 flex-1 flex-col gap-3 p-3" aria-labelledby="projects-heading">
          <h2 id="projects-heading" className="flex h-7 items-center text-xs font-semibold uppercase tracking-[0.08em] text-text-faint">{t("projects")}</h2>
          <ScrollArea className="min-h-0 flex-1" viewportClassName="[&>div]:!block">
            <div className={treeRow}>
              <TreeToggle name={project.name} expanded={projectExpanded} onClick={() => setProjectExpanded((value) => !value)} />
              <Button asChild className={`${navStyle} min-w-0`} variant="secondary">
                <a href="#/map" onClick={closeMobile} title={project.name}><GitBranchIcon data-icon="inline-start" /><span className="truncate">{project.name}</span></a>
              </Button>
            </div>
            {projectExpanded && <ul className="ml-3 flex min-w-0 flex-col gap-1 border-l border-border/60 pt-1 pl-4">
              {canvases.map(({ canvasId, title }) => {
                const tasks = demoTasks.filter((item) => item.canvasId === canvasId).map((item) => item.taskId);
                const expanded = expandedCanvases.has(canvasId);
                return <li key={canvasId} className="min-w-0">
                  <div className="grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-1">
                    <Button variant={activeCanvasId === canvasId ? "secondary" : "ghost"}
                      aria-current={view === "graph" && activeCanvasId === canvasId && !selectedTaskId ? "page" : undefined}
                      className={`h-8 min-w-0 justify-start gap-2 px-2 text-xs text-text-muted [&_svg]:size-4 ${selectedStyle}`}
                      onClick={() => { closeMobile(); onCanvasOpen(canvasId); }} title={title}>
                      <WorkflowIcon data-icon="inline-start" /><span className="flex-1 truncate text-left">{title}</span><Badge variant="outline">{tasks.length}</Badge>
                    </Button>
                    <TreeToggle name={`${t("tasks")}: ${title}`} expanded={expanded} onClick={() => setExpandedCanvases((current) => {
                      const next = new Set(current);
                      if (next.has(canvasId)) next.delete(canvasId); else next.add(canvasId);
                      return next;
                    })} />
                  </div>
                  {expanded && <ul className="ml-3 flex flex-col gap-1 border-l border-border/60 pt-1 pl-3">
                    {tasks.map((taskId) => <li key={taskId}>
                      <Button className={`h-8 w-full min-w-0 justify-start gap-2 bg-surface-muted/60 px-2 text-xs ${selectedStyle}`}
                        variant={activeCanvasId === canvasId && selectedTaskId === taskId ? "secondary" : "ghost"}
                        aria-current={activeCanvasId === canvasId && selectedTaskId === taskId ? "location" : undefined} onClick={() => { closeMobile(); onTaskOpen(canvasId, taskId); }} title={taskTitles[taskId]}>
                        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{taskTitles[taskId]}</span><Badge variant="outline">{taskId}</Badge>
                      </Button>
                    </li>)}
                  </ul>}
                </li>;
              })}
            </ul>}
          </ScrollArea>
        </section>
        <div className="flex h-13 shrink-0 items-center border-t border-border/80 px-4 text-xs text-text-muted">{t("sampleData")}</div>
      </aside>
      <section className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-app-shell text-text ${leftCollapsed ? "" : "min-[1100px]:rounded-l-xl"}`}>
        <header data-testid="workspace-titlebar" className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/80 bg-app-topbar px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex min-[1100px]:hidden"><SidebarToggle expanded={false} side="left" t={t} onClick={() => setMobilePanel("projects")} /></span>
            {leftCollapsed && <span className="hidden min-[1100px]:inline-flex"><SidebarToggle expanded={false} side="left" t={t} onClick={() => setLeftCollapsed(false)} /></span>}
            <span className="truncate text-sm font-medium min-[1100px]:hidden">{t(view === "map" ? "canvasMap" : view === "todo" ? "todo" : "canvas")}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {titlebarActions}
            {showPalette && <>
              <span className="inline-flex min-[1100px]:hidden"><SidebarToggle expanded={false} side="right" t={t} onClick={() => setMobilePanel("components")} /></span>
              {rightCollapsed && <span className="hidden min-[1100px]:inline-flex"><SidebarToggle expanded={false} side="right" t={t} onClick={() => setRightCollapsed(false)} /></span>}
            </>}
          </div>
        </header>
        <main data-testid="workspace-content" className={`min-h-0 flex-1 bg-app-canvas ${view === "todo" ? "p-4" : ""}`}>{children}</main>
      </section>
      {showPalette && <aside id="component-palette" data-testid="component-palette" aria-label={t("componentPalette")}
        className={`absolute inset-y-0 right-0 z-30 w-[min(300px,100vw)] shrink-0 flex-col overflow-hidden border-l border-border/80 bg-app-panel text-text min-[1100px]:static min-[1100px]:z-auto min-[1100px]:w-[300px] ${mobilePanel === "components" ? "flex" : "hidden"} ${rightCollapsed ? "min-[1100px]:hidden" : "min-[1100px]:flex"}`}>
        <header className="flex h-11 shrink-0 items-center justify-end border-b border-border/80 bg-app-topbar px-2">
          <span className="hidden min-[1100px]:inline-flex"><SidebarToggle expanded side="right" t={t} onClick={() => setRightCollapsed(true)} /></span>
          <span className="inline-flex min-[1100px]:hidden"><SidebarToggle expanded side="right" t={t} onClick={closeMobile} /></span>
        </header>
        <div className="grid gap-3 overflow-auto border-b border-border/80 p-3 pt-4">
          <h2 className="text-sm font-semibold text-text-strong">{t("componentPalette")}</h2>
          {([[t("nodeComponents"), [t("taskNode")]], [t("blockComponents"), [t("implementationBlock"), t("reviewBlock")]]] as const).map(([name, entries]) => (
            <section key={name} className="grid gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-text-faint">{name}</h3>
              <ul className="grid gap-2">
                {entries.map((entry) => <li key={entry} className="flex h-9 items-center gap-2 rounded-md border border-border/80 bg-surface-raised px-3 text-sm text-text">
                  <ComponentIcon className="size-4 shrink-0" aria-hidden="true" />{entry}
                </li>)}
              </ul>
            </section>
          ))}
        </div>
      </aside>}
    </div>
  );
}
