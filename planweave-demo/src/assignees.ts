export type CompactAssigneeChip = {
  workItemKey: string;
  label: string;
  initials: string | null;
  visible: boolean;
  tone: "assigned" | "issue" | "unassigned";
};

export type AssigneeSurfaceIndex = Record<string, CompactAssigneeChip>;

export function lookupBlockAssigneeChip(index: AssigneeSurfaceIndex, canvasId: string, ref: string) {
  return index[`${canvasId}:${ref}`] ?? null;
}
