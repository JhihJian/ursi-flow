import { Component, useCallback, useSyncExternalStore, type ReactNode } from "react";
import type { SlotEntry, SlotRegistry } from "./registry";

export { createSlotRegistry } from "./registry";
export type { SlotEntry, SlotRegistry } from "./registry";

export function useSlotEntries<Slots extends object, K extends keyof Slots & string>(
  registry: SlotRegistry<Slots>,
  slotName: K,
): readonly SlotEntry<Slots[K]>[] {
  const getSnapshot = useCallback(() => registry.entries(slotName), [registry, slotName]);
  return useSyncExternalStore(registry.subscribe, getSnapshot, getSnapshot);
}

class ContributionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <span role="alert">扩展内容加载失败。</span> : this.props.children;
  }
}

export function SlotContent<Props extends object>({ entries, context }: {
  entries: readonly SlotEntry<Props>[];
  context: NoInfer<Props>;
}) {
  return entries.map(({ key, Component: Contribution }) => (
    <ContributionBoundary key={key}>
      <Contribution {...context} />
    </ContributionBoundary>
  ));
}
