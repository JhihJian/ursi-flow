import { demoTasks, project, seedTodoItems } from "./demo-data";
import { todoStatuses, type DesktopTodoItem, type TodoFields } from "./model";

const key = `planweave-demo/v1/${project.projectId}/todos`;
const identity = (canvasId: string, ref: string) => `${canvasId}:${ref}`;
const seeds = new Map(seedTodoItems.map((item) => [identity(item.canvasId, item.ref), item]));

type TodoRecord = TodoFields & { canvasId: string; taskId: string; blockId: string };

function isRecord(value: unknown): value is TodoRecord {
  if (typeof value !== "object" || !value) return false;
  const item = value as Partial<TodoRecord>;
  return typeof item.title === "string" && item.title.trim().length > 0 &&
    todoStatuses.some((status) => item.status === status) && typeof item.assignee === "string" &&
    typeof item.description === "string" && typeof item.blockId === "string" && /^[a-z0-9-]+$/.test(item.blockId) &&
    demoTasks.some(({ canvasId, taskId }) => canvasId === item.canvasId && taskId === item.taskId);
}

export function readTodoItems(): DesktopTodoItem[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return seedTodoItems;
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || !rows.every(isRecord)) return seedTodoItems;
    const result = new Map<string, DesktopTodoItem>();
    for (const { canvasId, taskId, blockId, title, status, assignee, description } of rows) {
      const ref = `${taskId}/${blockId}`;
      const id = identity(canvasId, ref);
      const seed = seeds.get(id);
      result.set(id, { canvasId, taskId, blockId, title, status, assignee, description, ref,
        dependencyBlockers: seed?.dependencyBlockers ?? [], reviewGate: seed?.reviewGate ?? null });
    }
    return [...result.values()];
  } catch {
    return seedTodoItems;
  }
}

export function writeTodoItems(items: DesktopTodoItem[]) {
  localStorage.setItem(key, JSON.stringify(items.map(({ canvasId, taskId, blockId, title, status, assignee, description }) =>
    ({ canvasId, taskId, blockId, title, status, assignee, description }))));
}

export function newTodoItem(canvasId: string, taskId: string, fields: TodoFields, items: DesktopTodoItem[]): DesktopTodoItem {
  let blockId: string;
  do {
    blockId = `todo-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, "0")}`;
  } while (items.some((item) => item.canvasId === canvasId && item.ref === `${taskId}/${blockId}`));
  return { ...fields, canvasId, taskId, blockId, ref: `${taskId}/${blockId}`, dependencyBlockers: [], reviewGate: null };
}

export function findTodoReferences(items: DesktopTodoItem[], target: DesktopTodoItem) {
  const key = identity(target.canvasId, target.ref);
  return items.filter((item) => item !== target && (item.dependencyBlockers.includes(key) ||
    (item.canvasId === target.canvasId && item.reviewGate?.needsChangesReturnsTo.includes(target.ref))));
}
