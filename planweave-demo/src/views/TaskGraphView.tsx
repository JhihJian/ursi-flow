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
import type { DesktopCanvasNodeViewModel, DesktopTodoItem } from "../model";

const taskWidth = 320;
const taskHeight = 220;

type Translator = ReturnType<typeof createTranslator>;
type TaskNode = Node<{
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

function FocusTask({ taskId, revision, surface }: {
  taskId: string | null;
  revision: number;
  surface: RefObject<HTMLDivElement | null>;
}) {
  const { getNode, setCenter, viewportInitialized } = useReactFlow<TaskNode>();
  useEffect(() => {
    if (!viewportInitialized || !taskId) return;
    const frame = requestAnimationFrame(() => {
      const node = getNode(taskId);
      if (!node || !surface.current) return;
      const { clientWidth, clientHeight } = surface.current;
      const zoom = Math.max(0.1, Math.min(1, (clientWidth - 32) / taskWidth, (clientHeight - 32) / taskHeight));
      const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260;
      void setCenter(node.position.x + taskWidth / 2, node.position.y + taskHeight / 2, { zoom, duration });
    });
    return () => cancelAnimationFrame(frame);
  }, [getNode, revision, setCenter, surface, taskId, viewportInitialized]);
  return null;
}

export function TaskGraphView({ canvas, items, selectedTaskId, focusRevision, dark, onTaskSelect, onBlockOpen, t }: {
  canvas: DesktopCanvasNodeViewModel;
  items: DesktopTodoItem[];
  selectedTaskId: string | null;
  focusRevision: number;
  dark: boolean;
  onTaskSelect: (canvasId: string, taskId: string) => void;
  onBlockOpen: (ref: string, canvasId: string) => Promise<void>;
  t: Translator;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const { nodes, edges } = useMemo(() => {
    const blocksByTask = new Map<string, DesktopTodoItem[]>();
    const taskByRef = new Map<string, string>();
    for (const block of items) {
      if (block.canvasId !== canvas.canvasId) continue;
      const blocks = blocksByTask.get(block.taskId) ?? [];
      blocks.push(block);
      blocksByTask.set(block.taskId, blocks);
      taskByRef.set(`${canvas.canvasId}:${block.ref}`, block.taskId);
    }
    const edgesById = new Map<string, Edge>();
    const nodes = [...blocksByTask].map(([taskId, blocks], index): TaskNode => {
      for (const block of blocks) {
        for (const blocker of block.dependencyBlockers) {
          const source = taskByRef.get(blocker);
          if (!source || source === taskId) continue;
          const id = `${source}:${taskId}`;
          const color = dependencyEdgeColorForSource(source);
          edgesById.set(id, { id, source, target: taskId, type: "smoothstep", selectable: false,
            style: { stroke: color, strokeWidth: 2.2 }, markerEnd: { type: MarkerType.ArrowClosed, color } });
        }
      }
      const title = taskTitles[taskId] ?? taskId;
      return { id: taskId, type: "task", position: { x: 80 + index * 400, y: 80 }, ariaLabel: title,
        width: taskWidth, height: taskHeight,
        selected: taskId === selectedTaskId,
        data: { title, blocks, t, onBlockOpen: (ref) => void onBlockOpen(ref, canvas.canvasId) } };
    });
    return { nodes, edges: [...edgesById.values()] };
  }, [canvas.canvasId, items, onBlockOpen, selectedTaskId, t]);

  return <div className="relative h-full" ref={surface} data-testid="task-graph">
    <h1 title={canvas.title} className="pointer-events-none absolute top-3 left-3 z-10 max-w-[calc(100%-1.5rem)] truncate rounded-md border bg-app-panel px-2 py-1 text-sm font-semibold">{canvas.title}</h1>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={dark ? "dark" : "light"}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null}
      fitView={!selectedTaskId} fitViewOptions={{ maxZoom: 1 }} minZoom={0.1} proOptions={{ hideAttribution: true }}
      aria-label={t("canvas")} onNodeClick={(_event, node) => onTaskSelect(canvas.canvasId, node.id)}
      onKeyDownCapture={(event) => {
        if (!(event.target instanceof Element) || !event.target.matches(".react-flow__node")) return;
        const taskId = event.target.getAttribute("data-id");
        if (!taskId || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onTaskSelect(canvas.canvasId, taskId);
      }}>
      <FocusTask taskId={selectedTaskId} revision={focusRevision} surface={surface} />
      <Background color="var(--border)" gap={24} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  </div>;
}
