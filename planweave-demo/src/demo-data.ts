import type {
  DesktopCanvasExecutionPolicy, DesktopCanvasGraphViewModel, DesktopCanvasHealthBlockedBlock,
  DesktopCanvasNodeViewModel, DesktopProjectSummary,
  DesktopTodoGroups, DesktopTodoItem, TodoPhase, TodoStatus
} from "./model";
import type { AssigneeSurfaceIndex } from "./assignees";

export const project: DesktopProjectSummary = {
  projectId: "release-workspace", name: "Release Workspace", rootPath: "release-workspace",
  workspaceRoot: "release-workspace/.planweave", sourceRoot: "release-workspace/src", activeCanvasId: "foundation"
};

export const executorOptions = ["manual", "codex", "claude-code", "reviewer"];
const basePolicy: DesktopCanvasExecutionPolicy = { defaultExecutor: null, parallelEnabled: true, maxConcurrent: 3 };
const canvas = (canvasId: string, title: string, status: DesktopCanvasNodeViewModel["status"]): DesktopCanvasNodeViewModel => ({
  canvasId, title, status, packageDir: `plans/${canvasId}`, executionPolicy: basePolicy, diagnostics: []
});
const diagnostic = { code: "missing-release-notes", message: "Release notes are waiting for the final verification report.", severity: "warning" as const };
export const canvases = [
  canvas("foundation", "Foundation", "implemented"), canvas("delivery", "Delivery", "in_progress"),
  { ...canvas("verification", "Verification", "planned"), diagnostics: [diagnostic] },
  canvas("release", "Release", "planned")
];

const rows: [TodoStatus | "implemented", string, string, string, string, string[]?][] = [
  ["ready", "delivery", "workspace", "editor", "Implement the workspace editor"],
  ["ready", "delivery", "workspace", "review", "Review workspace integration"],
  ["ready", "verification", "quality", "fixtures", "Prepare browser fixtures"],
  ["in_progress", "delivery", "workspace", "graph", "Connect the dependency graph"],
  ["needs_changes", "delivery", "navigation", "refine", "Refine canvas navigation", ["delivery:workspace/graph"]],
  ["blocked", "verification", "quality", "smoke", "Run the release smoke suite", ["delivery:workspace/review"]],
  ["diverged", "release", "publish", "changelog", "Reconcile the release notes", ["verification:quality/smoke"]],
  ["implemented", "foundation", "setup", "shell", "Set up the application shell"],
  ["implemented", "foundation", "setup", "tokens", "Publish shared design tokens"]
];

export const taskTitles: Record<string, string> = {
  setup: "Project foundation", workspace: "Workspace experience", navigation: "Canvas navigation",
  quality: "Release verification", publish: "Publish release"
};

export const seedTodoItems: DesktopTodoItem[] = rows.map(([group, canvasId, taskId, blockId, title, dependencyBlockers = []]) => ({
  canvasId, ref: `${taskId}/${blockId}`, taskId, blockId, title,
  status: group === "implemented" ? "completed" : group, dependencyBlockers,
  assignee: blockId === "editor" ? "Mia Chen" : blockId === "review" ? "Alex Lin" : "",
  description: blockId === "smoke" ? "The workspace review must complete before smoke testing." : "",
  reviewGate: blockId === "review" ? {
    isGate: true, required: true, requiredReason: "Required before release verification.", executorRole: "reviewer",
    downstreamTasks: ["quality"], unlocksTasks: ["quality"], needsChangesReturnsTo: ["workspace/editor"]
  } : null
}));

export const demoTasks = canvases.flatMap(({ canvasId }) => [...new Set(seedTodoItems.filter((item) => item.canvasId === canvasId)
  .map(({ taskId }) => taskId))].map((taskId) => ({ canvasId, taskId, title: taskTitles[taskId] })));

const keyForBlock = (canvasId: string, ref: string) => `${canvasId}:${ref}`;
const seedByRef = new Map(seedTodoItems.map((item) => [keyForBlock(item.canvasId, item.ref), item]));
export const taskDependencies = seedTodoItems.flatMap((item) => item.dependencyBlockers.flatMap((ref) => {
  const blocker = seedByRef.get(ref);
  if (!blocker || (blocker.canvasId === item.canvasId && blocker.taskId === item.taskId)) return [];
  return [{ from: { canvasId: item.canvasId, taskId: item.taskId }, to: { canvasId: blocker.canvasId, taskId: blocker.taskId }, type: "depends_on" as const }];
}));

export function readDemoProjection(graph: DesktopCanvasGraphViewModel, items: DesktopTodoItem[]) {
  const todoGroups: DesktopTodoGroups = { planned: [], ready: [], in_progress: [], completed: [], needs_changes: [], blocked: [], diverged: [], implemented: [] };
  for (const item of items) todoGroups[item.status === "completed" ? "implemented" : item.status].push(item);
  const phases: TodoPhase[] = graph.canvases.map(({ canvasId, title }) => ({
    canvasId,
    canvasName: title,
    readyItems: todoGroups.ready.filter((item) => item.canvasId === canvasId),
    blockedCount: todoGroups.blocked.filter((item) => item.canvasId === canvasId).length
  }));
  const assignees: AssigneeSurfaceIndex = Object.fromEntries(items.filter(({ assignee }) => assignee).map((item) => {
    const key = keyForBlock(item.canvasId, item.ref);
    const initials = item.assignee.split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("").toUpperCase();
    return [key, { workItemKey: key, label: item.assignee, initials, visible: true, tone: "assigned" }];
  }));
  return { todoGroups, phases, assignees };
}

export function summarizeTasks(items: DesktopTodoItem[]): DesktopCanvasNodeViewModel["status"] {
  if (!items.length) return "planned";
  if (items.every(({ status }) => status === "completed")) return "implemented";
  if (items.some(({ status }) => status === "in_progress")) return "in_progress";
  return items.some(({ status }) => status === "ready") ? "ready" : "planned";
}

export function createGraph(currentCanvases: DesktopCanvasNodeViewModel[], items: DesktopTodoItem[]): DesktopCanvasGraphViewModel {
  const title = (id: string) => currentCanvases.find((entry) => entry.canvasId === id)?.title ?? id;
  const itemByRef = new Map(items.map((item) => [keyForBlock(item.canvasId, item.ref), item]));
  const blockedBlocks: DesktopCanvasHealthBlockedBlock[] = items.filter(({ status }) => status === "blocked").map((item) => {
    const { canvasId, taskId, blockId, ref, title: blockTitle, status } = item;
    const blockers = item.dependencyBlockers.flatMap((key) => {
      const source = itemByRef.get(key);
      if (!source || source.status === "completed") return [];
      return [{ kind: "task" as const, canvasId: source.canvasId, canvasTitle: title(source.canvasId), taskId: source.taskId,
        taskTitle: taskTitles[source.taskId], status: summarizeTasks(items.filter((entry) =>
          entry.canvasId === source.canvasId && entry.taskId === source.taskId)) ?? "planned" }];
    });
    return { blocked: { canvasId, canvasTitle: title(canvasId), taskId, taskTitle: taskTitles[taskId], blockId,
      blockRef: ref, blockTitle, status }, blockers, reason: item.description };
  });
  const edges = [["delivery", "foundation"], ["verification", "delivery"], ["release", "verification"]].map(([from, to]) => ({ from, to, type: "depends_on" as const }));
  return { projectId: project.projectId, projectTitle: project.name, edges,
    canvases: currentCanvases.map((canvas) => ({ ...canvas, status: summarizeTasks(items.filter(({ canvasId }) => canvasId === canvas.canvasId)) })),
    crossTaskEdges: taskDependencies.filter(({ from, to }) => from.canvasId !== to.canvasId),
    diagnostics: [diagnostic], health: { severity: "warning", blockedBlocks, diagnostics: [diagnostic],
      canvases: currentCanvases.map(({ canvasId, diagnostics }) => ({ canvasId, severity: diagnostics.length ? "warning" : "ok",
        diagnosticCount: diagnostics.length, blockerCount: blockedBlocks.filter(({ blocked }) => blocked.canvasId === canvasId).length })),
      edges: edges.map((edge) => {
        const blockerCount = blockedBlocks.filter(({ blocked, blockers }) =>
          blocked.canvasId === edge.from && blockers.some(({ canvasId }) => canvasId === edge.to)).length;
        return { ...edge, severity: blockerCount ? "warning" : "ok", diagnosticCount: 0, blockerCount };
      }) } };
}
