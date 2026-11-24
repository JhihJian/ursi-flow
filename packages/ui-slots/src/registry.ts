import type { ComponentType } from "react";

type SlotName<Slots extends object> = keyof Slots & string;

type Contribution<Props> = {
  id: string;
  order?: number;
  Component: ComponentType<Props>;
};

export type SlotEntry<Props> = Readonly<{
  id: string;
  order: number;
  Component: ComponentType<Props>;
  key: number;
}>;

export interface SlotRegistry<Slots extends object> {
  register<K extends SlotName<Slots>>(
    slot: K,
    contribution: Contribution<NoInfer<Slots[K]>>,
  ): () => void;
  entries<K extends SlotName<Slots>>(slot: K): readonly SlotEntry<Slots[K]>[];
  subscribe(listener: () => void): () => void;
}

type SlotState<Props> = { snapshot: readonly SlotEntry<Props>[] };
const emptySnapshot: readonly never[] = Object.freeze([]);
// Each registration gets its own identity, even when replacing the same ID.
let nextKey = 0;

export function createSlotRegistry<Slots extends object>(
  names: readonly (keyof Slots & string)[],
): SlotRegistry<Slots> {
  const slots: { [K in SlotName<Slots>]?: SlotState<Slots[K]> } = Object.create(null);
  const listeners = new Set<() => void>();

  for (const name of names) {
    slots[name] = { snapshot: emptySnapshot };
  }

  function getSlot<K extends SlotName<Slots>>(name: K): SlotState<Slots[K]> {
    const slot = slots[name];
    if (!slot) throw new Error(`Unknown slot: ${name}`);
    return slot;
  }

  function publish<Props>(slot: SlotState<Props>, entries: SlotEntry<Props>[]) {
    slot.snapshot = entries.length ? Object.freeze(entries) : emptySnapshot;
    for (const listener of [...listeners]) listener();
  }

  return {
    register(slotName, { id, order = 0, Component }) {
      const slot = getSlot(slotName);
      if (slot.snapshot.some((entry) => entry.id === id)) {
        throw new Error(`Duplicate contribution ID "${id}" in slot "${slotName}"`);
      }
      if (Number.isNaN(order)) throw new Error(`Invalid order for contribution "${id}"`);

      const entry = Object.freeze({ id, order, Component, key: nextKey++ });
      publish(slot, [...slot.snapshot, entry].sort((a, b) =>
        a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      ));

      return () => {
        if (slot.snapshot.includes(entry)) {
          publish(slot, slot.snapshot.filter((current) => current !== entry));
        }
      };
    },
    entries(slotName) {
      return getSlot(slotName).snapshot;
    },
    subscribe(listener) {
      const notify = () => listener();
      listeners.add(notify);
      return () => { listeners.delete(notify); };
    },
  };
}
