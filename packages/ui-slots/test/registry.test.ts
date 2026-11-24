import assert from "node:assert/strict";
import test from "node:test";
import { createSlotRegistry } from "../src/registry.ts";

type Slots = { toolbar: { title: string }; sidebar: { count: number } };
const Component = () => null;

function createRegistry() {
  return createSlotRegistry<Slots>(["toolbar", "sidebar"]);
}

test("entries are stable snapshots sorted by order, then ID", () => {
  const registry = createRegistry();
  const empty = registry.entries("toolbar");
  const emptySidebar = registry.entries("sidebar");
  assert.deepEqual(empty, []);
  assert.equal(registry.entries("toolbar"), empty);

  const dispose = registry.register("toolbar", { id: "z", Component });
  const initial = registry.entries("toolbar");
  registry.register("toolbar", { id: "b", order: -1, Component });
  registry.register("toolbar", { id: "a", order: 0, Component });
  registry.register("toolbar", { id: "c", order: 1, Component });

  const current = registry.entries("toolbar");
  assert.deepEqual(current.map(({ id }) => id), ["b", "a", "z", "c"]);
  assert.equal(registry.entries("toolbar"), current);
  assert.equal(registry.entries("sidebar"), emptySidebar);
  assert.deepEqual(initial.map(({ id }) => id), ["z"]);
  assert.equal(current[2], initial[0]);
  assert.equal(current[2]?.order, 0);

  dispose();
  assert.deepEqual(registry.entries("toolbar").map(({ id }) => id), ["b", "a", "c"]);
});

test("rejects duplicate IDs in one slot and undeclared slots", () => {
  const registry = createSlotRegistry<Slots>(["toolbar"]);
  registry.register("toolbar", { id: "shared", Component });
  const snapshot = registry.entries("toolbar");
  assert.throws(() => registry.register("toolbar", { id: "shared", Component }), /duplicate/i);
  assert.throws(() => registry.register("sidebar", { id: "shared", Component }), /unknown slot/i);
  assert.throws(() => registry.entries("sidebar"), /unknown slot/i);
  assert.equal(registry.entries("toolbar"), snapshot);

  const both = createRegistry();
  both.register("toolbar", { id: "shared", Component });
  both.register("sidebar", { id: "shared", Component });
});

test("publishes changes after updating the snapshot and only disposes its own registration", () => {
  const registry = createRegistry();
  const empty = registry.entries("toolbar");
  const observed: ReturnType<typeof registry.entries<"toolbar">>[] = [];
  const unsubscribe = registry.subscribe(() => observed.push(registry.entries("toolbar")));

  const dispose = registry.register("toolbar", { id: "plugin", Component });
  const first = registry.entries("toolbar");
  dispose();
  assert.equal(registry.entries("toolbar"), empty);
  const disposeReplacement = registry.register("toolbar", { id: "plugin", Component });
  const replacement = registry.entries("toolbar");
  dispose();
  assert.equal(registry.entries("toolbar"), replacement);
  assert.notEqual(first[0]?.key, replacement[0]?.key);

  unsubscribe();
  unsubscribe();
  disposeReplacement();
  assert.deepEqual(observed, [first, empty, replacement]);
});
