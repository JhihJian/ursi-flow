import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow,
  useReactFlow, type Edge, type Node, type NodeProps
} from "@xyflow/react";
import { ClipboardCheckIcon, SquareCodeIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { taskTitles } from "../demo-data";
import { dependencyEdgeColorForSource } from "../graph/dependencyEdgeVisual";
import { TaskNodeStatusMarker, taskNodeStatusVisual } from "../graph/taskNodeStatus";
import type { createTranslator } from "../i18n";
import type { DesktopCanvasGraphViewModel, DesktopTodoItem } from "../model";

const taskWidth = 320;
const taskHeight = 220;
// Keep React Flow's handle positions when focus changes the controlled nodes.
const taskDimensions = { width: taskWidth, height: taskHeight };

type Translator = ReturnType<typeof createTranslator>;
type TaskNode = Node<{
  canvasId: string;
  canvasName: string;
  taskId: string;
  title: string;
  blocks: DesktopTodoItem[];
  onBlockOpen: (ref: string) => void;
  t: Translator;
}, "task">;

function taskStatus(blocks: DesktopTodoItem[]) {
  if (blocks.every(({ status }) => status === "completed")) return "implemented";
  return (["in_progress", "diverged", "needs_changes", "blocked", "ready"] as const)
    .find((status) => blocks.some((block) => block.status === status)) ?? "planned";
}

function TaskNodeCard({ data, selected }: NodeProps<TaskNode>) {
  const status = taskStatus(data.blocks);
  const visual = taskNodeStatusVisual(status, false);
  return <Card size="sm" className={`h-full w-full overflow-hidden border ${visual.cardClassName} ${selected ? "outline-2 outline-offset-2 outline-state-selected" : ""}`}>
    <Handle type="target" position={Position.Left} style={{ top: "56%" }} />
    <CardHeader className="gap-1">
      <CardTitle className="flex items-start justify-between gap-2 text-sm">
        <span className="min-w-0 break-words">{data.title}</span>
        <TaskNodeStatusMarker label={status} status={status} hasException={false} />
      </CardTitle>
      <div className="truncate text-xs text-text-muted" title={data.canvasName}>{data.canvasName}</div>
    </CardHeader>
    <CardContent className="nowheel min-h-0 min-w-0 overflow-y-auto">
      <h2 className="mb-2 text-xs font-medium text-text-muted">{data.t("blockComponents")}</h2>
      <ul className="space-y-1">
        {data.blocks.map((block) => {
          const Icon = block.reviewGate ? ClipboardCheckIcon : SquareCodeIcon;
          return <li key={block.ref}>
            <Button variant="outline" size="sm" title={block.title}
              className="nodrag w-full min-w-0 justify-start gap-2 bg-surface-base px-2 text-xs"
              onClick={(event) => { event.stopPropagation(); data.onBlockOpen(block.ref); }}>
              <Icon aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-left">{block.title}</span>
              <Badge variant="outline">{block.status}</Badge>
            </Button>
          </li>;
        })}
      </ul>
    </CardContent>
    <Handle type="source" position={Position.Right} style={{ top: "44%" }} />
  </Card>;
}

const nodeTypes = { task: TaskNodeCard };

function FocusGraph({ canvasId, taskId, revision, surface }: {
  canvasId: string | null;
  taskId: string | null;
  revision: number;
  surface: RefObject<HTMLDivElement | null>;
}) {
  const { getNodes, getNodesBounds, setCenter, viewportInitialized } = useReactFlow<TaskNode>();
  useEffect(() => {
    if (!viewportInitialized) return;
    const frame = requestAnimationFrame(() => {
      const nodes = getNodes();
      if (!nodes.length || !surface.current) return;
      const targets = nodes.filter(({ data }) => data.canvasId === canvasId && (!taskId || data.taskId === taskId));
      const bounds = getNodesBounds(nodes);
      const targetBounds = targets.length ? getNodesBounds(targets) : bounds;
      const x = targetBounds.x + targetBounds.width / 2;
      const y = targetBounds.y + targetBounds.height / 2;
      const { clientWidth, clientHeight } = surface.current;
      // Leave room for the entire graph even when the centered target is near an edge.
      const width = 2 * Math.max(x - bounds.x, bounds.x + bounds.width - x);
      const height = 2 * Math.max(y - bounds.y, bounds.y + bounds.height - y);
      const zoom = Math.max(0.1, Math.min(1, (clientWidth - 40) / width, (clientHeight - 120) / height));
      const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260;
      void setCenter(x, y, { zoom, duration });
    });
    return () => cancelAnimationFrame(frame);
  }, [canvasId, getNodes, getNodesBounds, revision, setCenter, surface, taskId, viewportInitialized]);
  return null;
}

function taskNodeId(canvasId: string, taskId: string) {
  return `${canvasId}:${taskId}`;
}

export function TaskGraphView({ graph, items, focusCanvasId, selectedTaskId, focusRevision, dark, onTaskSelect, onBlockOpen, t }: {
  graph: DesktopCanvasGraphViewModel;
  focusCanvasId: string | null;
  items: DesktopTodoItem[];
  selectedTaskId: string | null;
  focusRevision: number;
  dark: boolean;
  onTaskSelect: (canvasId: string, taskId: string) => void;
  onBlockOpen: (ref: string, canvasId: string) => Promise<void>;
  t: Translator;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const { baseNodes, edges } = useMemo(() => {
    const baseNodes: TaskNode[] = [];
    const taskByRef = new Map<string, string>();
    for (const canvas of graph.canvases) {
      const blocksByTask = new Map<string, DesktopTodoItem[]>();
      for (const block of items) {
        if (block.canvasId !== canvas.canvasId) continue;
        const blocks = blocksByTask.get(block.taskId) ?? [];
        blocks.push(block);
        blocksByTask.set(block.taskId, blocks);
        taskByRef.set(`${canvas.canvasId}:${block.ref}`, taskNodeId(canvas.canvasId, block.taskId));
      }
      for (const [taskId, blocks] of blocksByTask) {
        const title = taskTitles[taskId] ?? taskId;
        const index = baseNodes.length;
        baseNodes.push({ id: taskNodeId(canvas.canvasId, taskId), type: "task", ariaLabel: title,
          position: { x: (index % 3) * 420, y: Math.floor(index / 3) * 320 },
          ...taskDimensions, measured: taskDimensions,
          data: { canvasId: canvas.canvasId, canvasName: canvas.title, taskId, title, blocks, t,
            onBlockOpen: (ref) => void onBlockOpen(ref, canvas.canvasId) } });
      }
    }
    const nodeIds = new Set(baseNodes.map(({ id }) => id));
    const edgesById = new Map<string, Edge>();
    const addDependency = (source: string, target: string) => {
      if (source === target || !nodeIds.has(source) || !nodeIds.has(target)) return;
      const id = `${source}->${target}`;
      const color = dependencyEdgeColorForSource(source);
      edgesById.set(id, { id, source, target, type: "smoothstep", selectable: false,
        style: { stroke: color, strokeWidth: 2.2 }, markerEnd: { type: MarkerType.ArrowClosed, color } });
    };
    for (const { id, data } of baseNodes) {
      for (const block of data.blocks) {
        for (const blocker of block.dependencyBlockers) {
          const source = taskByRef.get(blocker);
          if (source) addDependency(source, id);
        }
      }
    }
    for (const { from, to } of graph.crossTaskEdges) {
      addDependency(taskNodeId(to.canvasId, to.taskId), taskNodeId(from.canvasId, from.taskId));
    }
    return { baseNodes, edges: [...edgesById.values()] };
  }, [graph, items, onBlockOpen, t]);
  const nodes = useMemo(() => baseNodes.map((node) => ({ ...node,
    selected: node.data.canvasId === focusCanvasId && (!selectedTaskId || node.data.taskId === selectedTaskId)
  })), [baseNodes, focusCanvasId, selectedTaskId]);
  const tasksById = useMemo(() => new Map(baseNodes.map(({ id, data }) => [id, data])), [baseNodes]);

  return <div className="relative h-full" ref={surface} data-testid="task-graph">
    <h1 title={graph.projectTitle} className="pointer-events-none absolute top-3 left-3 z-10 max-w-[calc(100%-1.5rem)] truncate rounded-md border bg-app-panel px-2 py-1 text-sm font-semibold">{graph.projectTitle}</h1>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={dark ? "dark" : "light"}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null}
      minZoom={0.1} proOptions={{ hideAttribution: true }}
      aria-label={t("canvas")} onNodeClick={(_event, node) => onTaskSelect(node.data.canvasId, node.data.taskId)}
      onKeyDownCapture={(event) => {
        if (!(event.target instanceof Element) || !event.target.matches(".react-flow__node")) return;
        const task = tasksById.get(event.target.getAttribute("data-id") ?? "");
        if (!task || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onTaskSelect(task.canvasId, task.taskId);
      }}>
      <FocusGraph canvasId={focusCanvasId} taskId={selectedTaskId} revision={focusRevision} surface={surface} />
      <Background color="var(--border)" gap={24} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  </div>;
}
