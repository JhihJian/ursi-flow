import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { demoTasks } from "../demo-data";
import { todoStatuses, type DesktopCanvasNodeViewModel, type DesktopTodoItem, type TodoFields, type TodoStatus } from "../model";
import type { createTranslator } from "../i18n";

const fieldsClass = "grid min-w-0 gap-1 text-sm font-medium";
const selectClass = "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring";

export function TodoEditor({ item, canvases, canvasId, t, onSave, onCancel }: {
  item?: DesktopTodoItem;
  canvases: DesktopCanvasNodeViewModel[];
  canvasId: string;
  t: ReturnType<typeof createTranslator>;
  onSave: (canvasId: string, taskId: string, fields: TodoFields) => void;
  onCancel: () => void;
}) {
  const taskKey = (canvas: string, task: string) => `${canvas}:${task}`;
  const initialTask = item ?? demoTasks.find((task) => task.canvasId === canvasId) ?? demoTasks[0];
  const [target, setTarget] = useState(taskKey(initialTask.canvasId, initialTask.taskId));
  const [title, setTitle] = useState(item?.title ?? "");
  const [status, setStatus] = useState<TodoStatus>(item?.status ?? "ready");
  const [assignee, setAssignee] = useState(item?.assignee ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [error, setError] = useState(false);

  return <form className="grid min-w-0 gap-3" onSubmit={(event) => {
    event.preventDefault();
    const task = demoTasks.find(({ canvasId: canvas, taskId }) => taskKey(canvas, taskId) === target);
    if (!task || !title.trim()) return;
    try {
      onSave(task.canvasId, task.taskId, { title: title.trim(), status, assignee: assignee.trim(), description: description.trim() });
      setError(false);
    } catch {
      setError(true);
    }
  }}>
    <label className={fieldsClass}>{t("title")}
      <Input required autoFocus maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
    </label>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className={fieldsClass}>{t("todoParent")}
        <select className={selectClass} aria-label={t("todoParent")} disabled={Boolean(item)} value={target} onChange={(event) => setTarget(event.target.value)}>
          {canvases.map((canvas) => <optgroup key={canvas.canvasId} label={canvas.title}>
            {demoTasks.filter((task) => task.canvasId === canvas.canvasId).map((task) =>
              <option key={task.taskId} value={taskKey(canvas.canvasId, task.taskId)}>{task.title}</option>)}
          </optgroup>)}
        </select>
      </label>
      <label className={fieldsClass}>{t("status")}
        <select className={selectClass} aria-label={t("status")} value={status} onChange={(event) => setStatus(event.target.value as TodoStatus)}>
          {todoStatuses.map((value) => <option key={value} value={value}>{t(value === "in_progress" ? "inProgress" : value === "needs_changes" ? "needsChanges" : value)}</option>)}
        </select>
      </label>
    </div>
    <label className={fieldsClass}>{t("assignee")}
      <Input maxLength={80} value={assignee} onChange={(event) => setAssignee(event.target.value)} />
    </label>
    <label className={fieldsClass}>{t("todoDescription")}
      <textarea className="min-h-20 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring" maxLength={2000}
        value={description} onChange={(event) => setDescription(event.target.value)} />
    </label>
    {error && <p role="alert" className="text-sm text-destructive">{t("todoStorageError")}</p>}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onCancel}>{t("cancelTodoAction")}</Button>
      <Button type="submit" disabled={!title.trim()}><CheckIcon data-icon="inline-start" />{t("save")}</Button>
    </div>
  </form>;
}
