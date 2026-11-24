import { canvases, createGraph, project } from "./demo-data";
import type { DesktopCanvasExecutionPolicy, DesktopCanvasMapLayout } from "./model";

const prefix = `planweave-demo/v1/${project.projectId}`;
const layoutKey = `${prefix}/layout`;

function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isPolicy(value: unknown): value is DesktopCanvasExecutionPolicy {
  return isRecord(value) && (value.defaultExecutor === null || typeof value.defaultExecutor === "string") &&
    typeof value.parallelEnabled === "boolean" && typeof value.maxConcurrent === "number" &&
    Number.isSafeInteger(value.maxConcurrent) && value.maxConcurrent > 0;
}

function assertCanvas(canvasId: string) {
  if (!canvases.some((canvas) => canvas.canvasId === canvasId)) throw new Error("Canvas not found.");
}

export function readGraph() {
  return createGraph(canvases.map((canvas) => {
    const name = readStored(`${prefix}/name/${canvas.canvasId}`);
    const policy = readStored(`${prefix}/policy/${canvas.canvasId}`);
    return { ...canvas, title: isTitle(name) ? name : canvas.title, executionPolicy: isPolicy(policy) ? policy : canvas.executionPolicy };
  }));
}

function readLayout(): DesktopCanvasMapLayout {
  const stored = readStored(layoutKey);
  const positions = new Map<string, DesktopCanvasMapLayout["nodes"][number]>();
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      if (isRecord(entry) && typeof entry.canvasId === "string" && typeof entry.x === "number" &&
        typeof entry.y === "number" && Number.isFinite(entry.x) && Number.isFinite(entry.y)) {
        positions.set(entry.canvasId, { canvasId: entry.canvasId, x: entry.x, y: entry.y });
      }
    }
  }
  return { nodes: canvases.map(({ canvasId }, index) => positions.get(canvasId) ?? {
    canvasId, x: 80 + (index % 3) * 380, y: 80 + Math.floor(index / 3) * 220
  }) };
}

// Same async boundary as the desktop view. All operations stay in this browser.
export const browserProject = {
  async getCanvasGraphViewModel() { return readGraph(); },
  async getCanvasMapLayout() { return readLayout(); },
  async saveCanvasMapLayout(layout: DesktopCanvasMapLayout) {
    localStorage.setItem(layoutKey, JSON.stringify(layout.nodes));
    return layout;
  },
  async resetCanvasMapLayout() {
    localStorage.removeItem(layoutKey);
    return readLayout();
  },
  async updateCanvasExecutionPolicy(canvasId: string, input: DesktopCanvasExecutionPolicy) {
    assertCanvas(canvasId);
    if (!isPolicy(input)) throw new Error("Invalid execution policy.");
    localStorage.setItem(`${prefix}/policy/${canvasId}`, JSON.stringify(input));
  },
  async renameCanvas(canvasId: string, title: string) {
    assertCanvas(canvasId);
    if (!isTitle(title)) throw new Error("Invalid canvas name.");
    localStorage.setItem(`${prefix}/name/${canvasId}`, JSON.stringify(title.trim()));
  }
};
