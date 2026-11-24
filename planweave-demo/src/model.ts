import type { Node } from "@xyflow/react";

export type TaskStatus = "planned" | "ready" | "in_progress" | "implemented";
export type BlockStatus = "planned" | "ready" | "in_progress" | "completed" | "needs_changes" | "blocked" | "diverged";

export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
  transitionId?: string;
};

export type ReviewGateHint = {
  isGate: true;
  required: boolean;
  requiredReason: string;
  executorRole: "reviewer";
  downstreamTasks: string[];
  unlocksTasks: string[];
  needsChangesReturnsTo: string[];
};

export type DesktopCanvasDiagnosticIssue = ValidationIssue & {
  severity: "error" | "warning";
};

export type DesktopCanvasNodeViewModel = {
  canvasId: string;
  title: string;
  status: TaskStatus | null;
  packageDir: string;
  executionPolicy: DesktopCanvasExecutionPolicy | null;
  diagnostics: DesktopCanvasDiagnosticIssue[];
};

export type DesktopCanvasExecutionPolicy = {
  defaultExecutor: string | null;
  parallelEnabled: boolean;
  maxConcurrent: number;
};

export type DesktopCanvasHealthSeverity = "ok" | "warning" | "error";

export type DesktopCanvasHealthTaskRef = {
  canvasId: string;
  canvasTitle: string;
  taskId: string;
  taskTitle: string;
};

export type DesktopCanvasHealthBlockRef = DesktopCanvasHealthTaskRef & {
  blockRef: string;
  blockId: string;
  blockTitle: string;
  status: BlockStatus;
};

export type DesktopCanvasHealthBlocker =
  | {
      kind: "canvas";
      canvasId: string;
      canvasTitle: string;
    }
  | {
      kind: "task";
      canvasId: string;
      canvasTitle: string;
      taskId: string;
      taskTitle: string;
      status: TaskStatus;
    };

export type DesktopCanvasHealthBlockedBlock = {
  blocked: DesktopCanvasHealthBlockRef;
  blockers: DesktopCanvasHealthBlocker[];
  reason: string;
};

export type DesktopCanvasHealthCanvasSummary = {
  canvasId: string;
  severity: DesktopCanvasHealthSeverity;
  blockerCount: number;
  diagnosticCount: number;
};

export type DesktopCanvasHealthEdgeSummary = {
  from: string;
  to: string;
  type: "depends_on";
  severity: DesktopCanvasHealthSeverity;
  blockerCount: number;
  diagnosticCount: number;
};

export type DesktopCanvasHealth = {
  severity: DesktopCanvasHealthSeverity;
  canvases: DesktopCanvasHealthCanvasSummary[];
  edges: DesktopCanvasHealthEdgeSummary[];
  blockedBlocks: DesktopCanvasHealthBlockedBlock[];
  diagnostics: ValidationIssue[];
};

export type DesktopCanvasGraphEdgeViewModel = {
  from: string;
  to: string;
  type: "depends_on";
};

export type DesktopCrossCanvasTaskEdgeViewModel = {
  from: {
    canvasId: string;
    taskId: string;
  };
  to: {
    canvasId: string;
    taskId: string;
  };
  type: "depends_on";
};

export type DesktopCanvasGraphViewModel = {
  projectId: string;
  projectTitle: string;
  canvases: DesktopCanvasNodeViewModel[];
  edges: DesktopCanvasGraphEdgeViewModel[];
  crossTaskEdges: DesktopCrossCanvasTaskEdgeViewModel[];
  diagnostics: ValidationIssue[];
  health: DesktopCanvasHealth;
};
export type DesktopTodoGroupName = BlockStatus | "implemented";

export const todoStatuses = ["ready", "in_progress", "needs_changes", "blocked", "diverged", "completed"] as const;
export type TodoStatus = (typeof todoStatuses)[number];

export type TodoFields = {
  title: string;
  status: TodoStatus;
  assignee: string;
  description: string;
};

export type DesktopTodoItem = TodoFields & {
  canvasId: string;
  ref: string;
  taskId: string;
  blockId: string;
  dependencyBlockers: string[];
  reviewGate: ReviewGateHint | null;
};

export type DesktopTodoGroups = Record<DesktopTodoGroupName, DesktopTodoItem[]>;

export type TodoPhase = {
  canvasId: string;
  canvasName: string;
  readyItems: DesktopTodoItem[];
  blockedCount: number;
};

export type DesktopCanvasMapLayout = {
  nodes: { canvasId: string; x: number; y: number }[];
};

export type DesktopProjectSummary = {
  projectId: string;
  name: string;
  rootPath: string;
  workspaceRoot: string;
  sourceRoot: string;
  activeCanvasId: string;
};

export type CanvasNodeLabels = {
  copyAgentPrompt: string;
  dependency: string;
  error: string;
  openInFileManager: string;
  open: string;
  rename: string;
  warning: string;
};

export type CanvasNodeData = {
  canvas: DesktopCanvasNodeViewModel;
  health: DesktopCanvasHealthCanvasSummary | null;
  labels: CanvasNodeLabels;
  selected: boolean;
  onOpen: (canvasId: string) => void;
  onAgentPromptCopy: (canvas: DesktopCanvasNodeViewModel) => void;
  onRevealInFinder: (canvasId: string) => void;
  onRename: (canvas: DesktopCanvasNodeViewModel) => void;
  onSelect: (canvasId: string) => void;
};

export type CanvasFlowNode = Node<CanvasNodeData, "canvas">;
