import type {
  DesktopCanvasExecutionPolicy, DesktopCanvasGraphViewModel, DesktopCanvasHealthBlockedBlock,
  DesktopCanvasNodeViewModel, DesktopProjectSummary,
  DesktopTodoGroupName, DesktopTodoGroups, DesktopTodoItem, TodoPhase
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

const rows: [DesktopTodoGroupName, string, string, string, string, string[]?][] = [
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

export function readDemoProjection(graph: DesktopCanvasGraphViewModel) {
  const names = new Map(graph.canvases.map((entry) => [entry.canvasId, entry.title]));
  const todoGroups: DesktopTodoGroups = { planned: [], ready: [], in_progress: [], completed: [], needs_changes: [], blocked: [], diverged: [], implemented: [] };
  const items = rows.map(([group, canvasId, taskId, blockId, title, dependencyBlockers = []]) => {
    const item: DesktopTodoItem = {
      canvasId, canvasName: names.get(canvasId), ref: `${taskId}/${blockId}`, taskId, blockId, title,
      status: group === "implemented" ? "completed" : group, dependencyBlockers,
      reviewGate: blockId === "review" ? {
        isGate: true, required: true, requiredReason: "Required before release verification.", executorRole: "reviewer",
        downstreamTasks: ["quality"], unlocksTasks: ["quality"], needsChangesReturnsTo: ["workspace/editor"]
      } : null
    };
    todoGroups[group].push(item);
    return item;
  });
  const phases: TodoPhase[] = graph.canvases.map(({ canvasId, title }) => ({
    canvasId,
    canvasName: title,
    readyItems: todoGroups.ready.filter((item) => item.canvasId === canvasId),
    blockedCount: todoGroups.blocked.filter((item) => item.canvasId === canvasId).length
  }));
  return { items, todoGroups, phases };
}

export function createGraph(currentCanvases: DesktopCanvasNodeViewModel[]): DesktopCanvasGraphViewModel {
  const title = (id: string) => currentCanvases.find((entry) => entry.canvasId === id)?.title ?? id;
  const blockedBlocks: DesktopCanvasHealthBlockedBlock[] = [{
    blocked: { canvasId: "verification", canvasTitle: title("verification"), taskId: "quality", taskTitle: taskTitles.quality,
      blockId: "smoke", blockRef: "quality/smoke", blockTitle: "Run the release smoke suite", status: "blocked" },
    blockers: [{ kind: "task", canvasId: "delivery", canvasTitle: title("delivery"), taskId: "workspace", taskTitle: taskTitles.workspace, status: "in_progress" }],
    reason: "The workspace review must complete before smoke testing."
  }];
  const edges = [["delivery", "foundation"], ["verification", "delivery"], ["release", "verification"]].map(([from, to]) => ({ from, to, type: "depends_on" as const }));
  return { projectId: project.projectId, projectTitle: project.name, canvases: currentCanvases, edges,
    crossTaskEdges: [{ from: { canvasId: "verification", taskId: "quality" }, to: { canvasId: "delivery", taskId: "workspace" }, type: "depends_on" }],
    diagnostics: [diagnostic], health: { severity: "warning", blockedBlocks, diagnostics: [diagnostic],
      canvases: currentCanvases.map(({ canvasId, diagnostics }) => ({ canvasId, severity: diagnostics.length ? "warning" : "ok",
        diagnosticCount: diagnostics.length, blockerCount: canvasId === "verification" ? 1 : 0 })),
      edges: edges.map((edge) => ({ ...edge, severity: edge.from === "verification" ? "warning" : "ok",
        diagnosticCount: 0, blockerCount: edge.from === "verification" ? 1 : 0 })) } };
}

const assignee = (workItemKey: string, label: string, initials: string) => ({ workItemKey, label, initials, visible: true, tone: "assigned" as const });
export const assignees: AssigneeSurfaceIndex = {
  "delivery:workspace/editor": assignee("delivery:workspace/editor", "Mia Chen", "MC"),
  "delivery:workspace/review": assignee("delivery:workspace/review", "Alex Lin", "AL")
};
