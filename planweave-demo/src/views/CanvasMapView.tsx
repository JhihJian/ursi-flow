import type { TaskCanvasRenameHandler } from "../renameResult";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  type Edge,
  MiniMap,
  type OnNodesChange,
  ReactFlow,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import type {
  DesktopCanvasExecutionPolicy,
  DesktopCanvasNodeViewModel,
  DesktopProjectSummary
} from "@/model";
import { ClipboardIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { browserProject } from "../browser-project";
import type { createTranslator } from "../i18n";
import {
  canvasMapEdges,
  canvasMapNodes,
  canvasNodeTypes,
  type DisplayCanvasEdgeData
} from "../graph/canvasFlowModel";
import { styleDependencyEdgesForInteraction } from "../graph/dependencyEdgeVisual";
import { useCanvasMap } from "../hooks/useCanvasMap";
import type { CanvasFlowNode } from "@/model";
import { CanvasMapInspector } from "./CanvasMapInspector";
import { CanvasMapRenameEditor } from "./CanvasMapRenameEditor";

type CanvasMapViewProps = {
  dark: boolean;
  executorOptions: readonly string[];
  handleOpenBlockInspector: (ref: string, canvasId?: string | null) => Promise<void>;
  handleRevealTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleRenameTaskCanvas: TaskCanvasRenameHandler;
  onCanvasOpen: (id: string) => void;
  onAgentPromptCopied: () => void;
  onTaskPanelSelect: (canvasId: string, taskId: string) => void;
  packageExecutorNames: readonly string[];
  refreshProjectDerivedState: () => void;
  selectedProject: DesktopProjectSummary;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

function canvasEdgeData(edge: Edge | null): DisplayCanvasEdgeData | null {
  const data = edge?.data as Partial<DisplayCanvasEdgeData> | undefined;
  if (!data?.manifestEdgeType || !data.manifestFrom || !data.manifestTo) {
    return null;
  }
  return {
    health: data.health ?? null,
    manifestEdgeType: data.manifestEdgeType,
    manifestFrom: data.manifestFrom,
    manifestTo: data.manifestTo
  };
}

function AgentScopeCard({
  canvas,
  onCopy,
  selectedProject,
  t
}: {
  canvas: DesktopCanvasNodeViewModel;
  onCopy: (canvas: DesktopCanvasNodeViewModel) => void;
  selectedProject: DesktopProjectSummary;
  t: ReturnType<typeof createTranslator>;
}) {
  const sourceRoot = selectedProject.sourceRoot ?? "";
  return (
    <Card className="min-w-0 max-w-full overflow-hidden" size="sm">
      <CardHeader className="min-w-0">
        <CardTitle className="min-w-0 truncate text-sm">{t("agentScope")}</CardTitle>
        <CardAction>
          <Button
            aria-label={t("copyAgentPrompt")}
            title={t("copyAgentPrompt")}
            size="icon-sm"
            variant="outline"
            onClick={() => onCopy(canvas)}
          >
            <ClipboardIcon data-icon="inline-start" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm">
        <ScopeField label={t("projectName")} value={selectedProject.name} />
        <ScopeField label={t("projectId")} value={selectedProject.projectId} />
        <ScopeField label={t("projectRoot")} value={selectedProject.rootPath} />
        <ScopeField label={t("workspaceRoot")} value={selectedProject.workspaceRoot} />
        <ScopeField label={t("canvasName")} value={canvas.title} />
        <ScopeField label={t("canvasId")} value={canvas.canvasId} />
        <ScopeField label={t("packageDir")} value={canvas.packageDir} />
        <ScopeField label={t("sourceRoot")} value={sourceRoot} />
      </CardContent>
    </Card>
  );
}

function ScopeField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className="block max-w-full whitespace-normal break-words font-mono text-xs text-text-strong"
        style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
        title={value || "-"}
      >
        {value || "-"}
      </div>
    </div>
  );
}

export function CanvasMapView({
  dark,
  executorOptions,
  handleOpenBlockInspector,
  handleRevealTaskCanvas,
  handleRenameTaskCanvas,
  onCanvasOpen,
  onAgentPromptCopied,
  onTaskPanelSelect,
  packageExecutorNames,
  refreshProjectDerivedState,
  selectedProject,
  setError,
  t
}: CanvasMapViewProps) {
  const {
    canvasGraph,
    canvasMapLayout,
    layoutDirty,
    layoutPending,
    loadCanvasMap,
    resetCanvasMapLayout,
    retrySaveCanvasMapLayout,
    saveCanvasMapLayoutFromNodes,
    selectedCanvas,
    selectedMapCanvasId,
    setSelectedMapCanvasId
  } = useCanvasMap({ activeCanvasId: selectedProject.activeCanvasId, selectedProject, setError });
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const dependencyLabel = t("canvasDependency");
  const copyAgentPromptLabel = t("copyAgentPrompt");
  const errorLabel = t("error");
  const enterCanvasLabel = t("enterCanvas");
  const openInFileManagerLabel = t("previewPackage");
  const renameTaskCanvasLabel = t("renameTaskCanvas");
  const warningLabel = t("warning");
  const canvasNodeLabels = useMemo(
    () => ({
      copyAgentPrompt: copyAgentPromptLabel,
      dependency: dependencyLabel,
      error: errorLabel,
      openInFileManager: openInFileManagerLabel,
      open: enterCanvasLabel,
      rename: renameTaskCanvasLabel,
      warning: warningLabel
    }),
    [
      copyAgentPromptLabel,
      dependencyLabel,
      enterCanvasLabel,
      errorLabel,
      openInFileManagerLabel,
      renameTaskCanvasLabel,
      warningLabel
    ]
  );

  const openCanvas = onCanvasOpen;
  const openTask = onTaskPanelSelect;
  const openBlock = (canvasId: string, blockRef: string) => void handleOpenBlockInspector(blockRef, canvasId);
  const copyAgentPrompt = useCallback(
    async (canvas: DesktopCanvasNodeViewModel) => {
      try {
        await navigator.clipboard.writeText(`Project: ${selectedProject.name}\nCanvas: ${canvas.title} (${canvas.canvasId})\nPackage: ${canvas.packageDir}`);
        onAgentPromptCopied();
      } catch {
        setError(t("clipboardUnavailable"));
      }
    },
    [onAgentPromptCopied, selectedProject, setError, t]
  );
  const revealCanvasInFinder = useCallback(
    (canvasId: string) => {
      void handleRevealTaskCanvas(selectedProject, canvasId);
    },
    [handleRevealTaskCanvas, selectedProject]
  );
  const [renamingCanvas, setRenamingCanvas] = useState<DesktopCanvasNodeViewModel | null>(null);
  const renameCanvas = useCallback(
    (canvas: DesktopCanvasNodeViewModel) => {
      setSelectedMapCanvasId(canvas.canvasId);
      setSelectedEdgeId(null);
      setRenamingCanvas(canvas);
    },
    [setSelectedMapCanvasId]
  );
  const openCanvasRef = useRef(openCanvas);
  const copyAgentPromptRef = useRef(copyAgentPrompt);
  const revealCanvasInFinderRef = useRef(revealCanvasInFinder);
  const renameCanvasRef = useRef(renameCanvas);

  useEffect(() => {
    openCanvasRef.current = openCanvas;
    copyAgentPromptRef.current = copyAgentPrompt;
    revealCanvasInFinderRef.current = revealCanvasInFinder;
    renameCanvasRef.current = renameCanvas;
  }, [copyAgentPrompt, openCanvas, renameCanvas, revealCanvasInFinder]);

  const handleCanvasOpen = useCallback((canvasId: string) => {
    openCanvasRef.current(canvasId);
  }, []);
  const handleAgentPromptCopy = useCallback((canvas: DesktopCanvasNodeViewModel) => {
    copyAgentPromptRef.current(canvas);
  }, []);
  const handleCanvasReveal = useCallback((canvasId: string) => {
    revealCanvasInFinderRef.current(canvasId);
  }, []);
  const handleCanvasRename = useCallback((canvas: DesktopCanvasNodeViewModel) => {
    renameCanvasRef.current(canvas);
  }, []);
  const saveExecutionPolicy = useCallback(
    async (canvasId: string, input: DesktopCanvasExecutionPolicy) => {
      try {
        await browserProject.updateCanvasExecutionPolicy(canvasId, input);
        await loadCanvasMap();
        refreshProjectDerivedState();
      } catch (caught: unknown) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [loadCanvasMap, refreshProjectDerivedState, setError]
  );

  useEffect(() => {
    if (!canvasGraph) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes(
      canvasMapNodes(
        canvasGraph,
        canvasMapLayout,
        canvasNodeLabels,
        selectedMapCanvasId,
        handleCanvasOpen,
        handleAgentPromptCopy,
        handleCanvasReveal,
        handleCanvasRename,
        setSelectedMapCanvasId
      )
    );
    setEdges(canvasMapEdges(canvasGraph));
  }, [
    canvasGraph,
    canvasMapLayout,
    canvasNodeLabels,
    handleAgentPromptCopy,
    handleCanvasOpen,
    handleCanvasRename,
    handleCanvasReveal,
    selectedMapCanvasId,
    setEdges,
    setNodes,
    setSelectedMapCanvasId
  ]);

  const selectedEdgeData = canvasEdgeData(edges.find((edge) => edge.id === selectedEdgeId) ?? null);
  const styledEdges = useMemo(
    () => styleDependencyEdgesForInteraction(edges, { hoveredEdgeId, hoveredNodeId })
      .map((edge) => ({ ...edge, selected: edge.id === selectedEdgeId })),
    [edges, hoveredEdgeId, hoveredNodeId, selectedEdgeId]
  );
  const agentScopeCanvasId =
    selectedMapCanvasId ??
    selectedProject.activeCanvasId ??
    canvasGraph?.canvases[0]?.canvasId ??
    null;
  const agentScopeCanvas =
    canvasGraph?.canvases.find((canvas) => canvas.canvasId === agentScopeCanvasId) ??
    canvasGraph?.canvases[0] ??
    null;
  const selectedManifestEdge = selectedEdgeData
    ? (canvasGraph?.edges.find(
        (edge) =>
          edge.from === selectedEdgeData.manifestFrom &&
          edge.to === selectedEdgeData.manifestTo &&
          edge.type === selectedEdgeData.manifestEdgeType
      ) ?? null)
    : null;

  const closeInspector = useCallback(() => {
    setSelectedMapCanvasId(null);
    setSelectedEdgeId(null);
  }, [setSelectedMapCanvasId]);

  const handleNodesChange = useCallback<OnNodesChange<CanvasFlowNode>>((changes) => {
    onNodesChange(changes);
    if (changes.some((change) => change.type === "position" && change.position && change.dragging === false)) {
      void saveCanvasMapLayoutFromNodes(applyNodeChanges(changes, nodes));
    }
  }, [nodes, onNodesChange, saveCanvasMapLayoutFromNodes]);

  if (!canvasGraph) return <div role="status" className="grid h-full place-items-center text-sm text-text-muted">{t("canvasMapLayoutLoading")}</div>;

  const layoutStatusLabel =
    layoutPending === "save"
      ? t("canvasMapLayoutSaving")
      : layoutPending === "reset"
        ? t("canvasMapLayoutResetting")
        : layoutPending === "load"
          ? t("canvasMapLayoutLoading")
          : layoutDirty
            ? t("canvasMapLayoutUnsaved")
            : null;
  const showLayoutStatus = layoutStatusLabel !== null;
  const showRetrySave = layoutDirty && layoutPending === null;

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,11fr)_minmax(0,9fr)] md:grid-cols-[minmax(0,1fr)_320px] md:grid-rows-1">
      <div className="relative min-h-0">
        {showLayoutStatus ? (
          <div
            className="pointer-events-none absolute top-3 left-1/2 z-20 w-[min(420px,calc(100%-1.5rem))] -translate-x-1/2"
            data-testid="canvas-map-layout-status"
          >
            <div
              className={`pointer-events-auto flex items-center gap-2 rounded-md border px-3 py-2 text-xs shadow-sm ${
                layoutDirty && layoutPending === null
                  ? "border-amber-500/40 bg-background text-amber-700 dark:text-amber-300"
                  : "border-border/80 bg-background text-text-muted"
              }`}
              role="status"
            >
              <span className="min-w-0 flex-1">{layoutStatusLabel}</span>
              {showRetrySave ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="canvas-map-layout-retry-save"
                  onClick={() => void retrySaveCanvasMapLayout()}
                >
                  {t("canvasMapLayoutRetrySave")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        <ReactFlow
          colorMode={dark ? "dark" : "light"}
          nodes={nodes}
          edges={styledEdges}
          nodeTypes={canvasNodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_event, node) => {
            setSelectedMapCanvasId(node.id);
            setSelectedEdgeId(null);
          }}
          onKeyDownCapture={(event) => {
            const target = event.target;
            if (!(target instanceof Element) || !target.matches(".react-flow__node, .react-flow__edge")) return;
            const id = target.getAttribute("data-id");
            if (event.key === "Escape") {
              closeInspector();
            } else if (id && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              event.stopPropagation();
              const isNode = target.matches(".react-flow__node");
              setSelectedMapCanvasId(isNode ? id : null);
              setSelectedEdgeId(isNode ? null : id);
            }
          }}
          nodesConnectable={false}
          deleteKeyCode={null}
          onNodeMouseEnter={(_event, node) => setHoveredNodeId(node.id)}
          onNodeMouseLeave={(_event, node) =>
            setHoveredNodeId((current) => (current === node.id ? null : current))
          }
          onEdgeClick={(_event, edge) => {
            setSelectedEdgeId(edge.id);
            setSelectedMapCanvasId(null);
          }}
          onEdgeMouseEnter={(_event, edge) => setHoveredEdgeId(edge.id)}
          onEdgeMouseLeave={(_event, edge) =>
            setHoveredEdgeId((current) => (current === edge.id ? null : current))
          }
          onPaneClick={closeInspector}
          onPaneMouseEnter={() => {
            setHoveredEdgeId(null);
            setHoveredNodeId(null);
          }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.1}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-t border-border/80 bg-app-panel text-text md:border-t-0 md:border-l">
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/80 bg-app-topbar px-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <GitBranchIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{t("canvasMap")}</span>
            {layoutDirty ? (
              <span
                className="truncate text-xs font-normal text-amber-700 dark:text-amber-300"
                data-testid="canvas-map-layout-dirty-badge"
              >
                {t("canvasMapLayoutUnsaved")}
              </span>
            ) : null}
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("resetCanvasMapLayout")}
            title={t("resetCanvasMapLayout")}
            onClick={() => void resetCanvasMapLayout()}
          >
            <RotateCcwIcon data-icon="inline-start" />
          </Button>
        </div>
        <ScrollArea
          className="min-h-0 flex-1 overflow-x-hidden"
          viewportClassName="[&>div]:!block [&>div]:!min-w-0 [&>div]:!w-full"
        >
          <div className="flex min-w-0 max-w-full flex-col gap-3 overflow-hidden p-3 pr-4">
            {renamingCanvas ? (
              <CanvasMapRenameEditor
                key={renamingCanvas.canvasId}
                canvas={renamingCanvas}
                project={selectedProject}
                scopeKey={renamingCanvas.canvasId}
                onClose={() => setRenamingCanvas(null)}
                onSave={async (...args) => {
                  const result = await handleRenameTaskCanvas(...args);
                  if (result.status === "saved") await loadCanvasMap();
                  return result;
                }}
                t={t}
              />
            ) : null}
            {agentScopeCanvas ? (
              <AgentScopeCard
                canvas={agentScopeCanvas}
                onCopy={copyAgentPrompt}
                selectedProject={selectedProject}
                t={t}
              />
            ) : null}
            <CanvasMapInspector
              executorOptions={executorOptions}
              graph={canvasGraph}
              onExecutionPolicySave={saveExecutionPolicy}
              onClose={closeInspector}
              onBlockOpen={openBlock}
              onCanvasOpen={openCanvas}
              onTaskOpen={openTask}
              packageExecutorNames={packageExecutorNames}
              selectedCanvas={selectedCanvas}
              selectedCanvasId={selectedMapCanvasId}
              selectedEdge={selectedManifestEdge}
              t={t}
            />
          </div>
        </ScrollArea>
      </aside>
    </div>
  );
}
