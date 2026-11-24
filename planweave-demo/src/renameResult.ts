import type { DesktopProjectSummary } from "@/model";

export type RenameResult =
  | { status: "saved" }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

export type RenameRequest = { isCurrent: () => boolean };

export type ProjectRenameHandler = (
  project: DesktopProjectSummary,
  name: string,
  request: RenameRequest
) => Promise<RenameResult>;

export type TaskCanvasRenameHandler = (
  project: DesktopProjectSummary,
  canvasId: string,
  name: string,
  request: RenameRequest
) => Promise<RenameResult>;
