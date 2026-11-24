import { expect, test, type Locator, type Page } from "@playwright/test";

const layoutKey = "planweave-demo/v1/release-workspace/layout";
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const position = (locator: Locator) => locator.evaluate((element) => element.style.transform);

async function drag(page: Page, locator: Locator) {
  await locator.hover({ position: { x: 48, y: 20 } });
  const box = (await locator.boundingBox())!;
  await page.mouse.move(box.x + 48, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 108, box.y + 70, { steps: 8 });
  await page.mouse.up();
}

test("TODO opens phased and grouped items and preserves scroll on close", async ({ page }) => {
  await page.goto("/#/todo");
  await expect(page.getByRole("heading", { name: "Canvas phases" })).toBeVisible();
  await page.getByRole("button", { name: "workspace/editor", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName("Implement the workspace editor");
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /^Run the release smoke suite/ }).click();
  const scroll = page.getByTestId("todo-view").locator("[data-slot=scroll-area-viewport]");
  const previous = await scroll.evaluate((element) => element.scrollTop);
  expect(previous).toBeGreaterThan(0);
  await expect(page.getByRole("dialog")).toContainText("delivery:workspace/review");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(previous);
});

test("TODO limits phase summaries and block details to task tracking", async ({ page }) => {
  await page.goto("/#/todo");
  const removedLabels = /dispatch|shared resources|派发|共享资源/i;
  const todo = page.getByTestId("todo-view");
  const phases = page.getByRole("heading", { name: "Canvas phases" }).locator("xpath=ancestor::section[1]");
  await expect(phases.getByText("Ready items: 3", { exact: true })).toBeVisible();
  await expect(phases.getByText("blocked", { exact: true })).toHaveCount(4);
  await expect(todo).not.toContainText(removedLabels);
  await expect(todo.getByText("Mia Chen", { exact: true })).toBeVisible();
  await expect(todo.getByText("Required review", { exact: true })).toBeVisible();
  await phases.getByRole("button", { name: "workspace/review", exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail).toHaveAccessibleName("Review workspace integration");
  await expect(detail).toContainText("Dependency blockers");
  await expect(detail).toContainText("Review gate");
  await expect(detail).not.toContainText(removedLabels);
});

test("creates, reads, updates and deletes a todo across views and reloads", async ({ page }) => {
  await page.goto("/#/todo");
  await page.getByRole("button", { name: "New todo", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const title = dialog.getByRole("textbox", { name: "Title", exact: true });
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await title.fill("Check browser handoff");
  await dialog.getByLabel("Parent task").selectOption("delivery:navigation");
  await dialog.getByRole("textbox", { name: "Assignee" }).fill("Sam Lee");
  await dialog.getByRole("textbox", { name: "Description" }).fill("Verify the checklist.");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("Check browser handoff");
  await expect(dialog).toContainText("Sam Lee");
  await expect(dialog).toContainText("Verify the checklist.");
  const itemLink = page.url();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Ready items: 4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Check browser handoff/ }).click();
  await dialog.getByRole("button", { name: "Edit todo" }).click();
  await title.fill("Confirm browser handoff");
  await dialog.getByLabel("Status", { exact: true }).selectOption("completed");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("Confirm browser handoff");
  expect(page.url()).toBe(itemLink);
  await page.reload();
  await expect(dialog).toHaveAccessibleName("Confirm browser handoff");
  await expect(dialog.getByText("completed", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Open canvas" }).click();
  await expect(page.getByTestId("task-graph").getByRole("button", { name: /^Confirm browser handoff/ })).toBeVisible();
  await page.getByTestId("project-sidebar").getByRole("link", { name: "Todo" }).click();
  await expect(page.getByText("Ready items: 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Confirm browser handoff/ }).click();
  await dialog.getByRole("button", { name: "Delete todo" }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("Confirm browser handoff");
  await dialog.getByRole("button", { name: "Delete todo" }).click();
  await dialog.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: /^Confirm browser handoff/ })).toHaveCount(0);
  await page.goto(itemLink);
  await expect(dialog).toHaveAccessibleName("This sample item was not found.");
});

test("rejects deletion of a referenced todo and keeps task nodes and edges after deleting the last block", async ({ page }) => {
  await page.goto("/#/todo");
  await page.getByRole("button", { name: "workspace/review", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete todo" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Run the release smoke suite");
  await expect(dialog.getByRole("button", { name: "Confirm deletion" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Refine canvas navigation/ }).click();
  await dialog.getByRole("button", { name: "Delete todo" }).click();
  await dialog.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto("/#/graph?canvas=delivery&task=navigation");
  const graph = page.getByTestId("task-graph");
  await expect(graph.locator('.react-flow__node[data-id="delivery:navigation"]')).toHaveClass(/\bselected\b/);
  await expect(graph.locator(".react-flow__node")).toHaveCount(5);
  await expect(graph.locator(".react-flow__edge")).toHaveCount(3);
  await expect(graph.getByRole("button", { name: /^Refine canvas navigation/ })).toHaveCount(0);
});

test("updates the map blocker from the same saved todo", async ({ page }) => {
  await page.goto("/#/todo");
  await page.getByRole("button", { name: /^Run the release smoke suite/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Edit todo" }).click();
  await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Run the browser smoke suite");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("Run the browser smoke suite");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Canvas Map" }).click();
  const inspector = page.getByTestId("map-inspector");
  await node(page, "verification").click({ position: { x: 35, y: 25 } });
  await expect(inspector.getByText("Run the browser smoke suite", { exact: true })).toBeVisible();
  await inspector.getByRole("button", { name: "Open block", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit todo" }).click();
  await dialog.getByLabel("Status", { exact: true }).selectOption("completed");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toContainText("completed");
  await page.keyboard.press("Escape");
  await expect(inspector.getByText("Run the browser smoke suite", { exact: true })).toHaveCount(0);
});

test("retains the draft when a todo write fails and allows retry", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith("/todos") && !failed) {
        failed = true;
        throw new DOMException("Storage unavailable", "QuotaExceededError");
      }
      original.call(this, key, value);
    };
  });
  await page.goto("/#/todo");
  await page.getByRole("button", { name: "New todo", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const title = dialog.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("Keep this draft");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not save changes");
  await expect(title).toHaveValue("Keep this draft");
  await expect(page.getByText("Ready items: 3", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("Keep this draft");
  await expect(page.getByText("Ready items: 4", { exact: true })).toBeVisible();
});

test("map inspects dependencies and follows the blocked block link", async ({ page }) => {
  await page.goto("/#/map");
  await expect(page.locator(".react-flow__minimap")).toBeVisible();
  await node(page, "verification").click({ position: { x: 35, y: 25 } });
  await expect(page.getByTestId("map-inspector").getByText("missing-release-notes").first()).toBeVisible();
  const edge = page.locator('.react-flow__edge[data-id="verification-depends_on-delivery"]');
  const point = await edge.locator(".react-flow__edge-path").evaluate((element: SVGPathElement) => {
    const point = element.getPointAtLength(element.getTotalLength() / 2);
    const screen = point.matrixTransform(element.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("map-inspector").getByText("Canvas dependency", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open block", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName("Run the release smoke suite");
  await page.keyboard.press("Escape");
  const map = page.locator(".react-flow");
  await map.locator(".react-flow__pane").click({ position: { x: 40, y: 50 } });
  await expect(page.getByText("No canvas selected", { exact: true })).toBeVisible();
  await node(page, "foundation").getByRole("button", { name: "Open canvas" }).click();
  await expect(page.getByTestId("task-graph").getByText("Publish shared design tokens")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("keyboard selects nodes and saves arrow-key movement", async ({ page }) => {
  await page.goto("/#/map");
  const delivery = node(page, "delivery");
  const initial = await position(delivery);
  await delivery.press("Enter");
  await expect(delivery).toHaveClass(/\bselected\b/);
  await expect(page.getByTestId("map-inspector").getByText("Delivery", { exact: true }).first()).toBeVisible();
  await delivery.press("ArrowRight");
  await expect.poll(() => position(delivery)).not.toBe(initial);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), layoutKey)).not.toBeNull();
  await delivery.press("Escape");
  await expect(page.getByText("No canvas selected", { exact: true })).toBeVisible();
});

test("layout survives a page switch and reload; reset leaves names and policy intact", async ({ page }) => {
  await page.goto("/#/map");
  const foundation = node(page, "foundation");
  await expect(foundation).toBeVisible();
  const initial = await position(foundation);
  await drag(page, foundation);
  await expect.poll(() => position(foundation)).not.toBe(initial);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), layoutKey)).not.toBeNull();
  const moved = await position(foundation);
  await page.getByRole("link", { name: "Todo" }).click();
  await page.getByRole("link", { name: "Canvas Map" }).click();
  await expect.poll(() => position(foundation)).toBe(moved);
  await foundation.click({ button: "right", position: { x: 42, y: 25 } });
  await page.getByRole("menuitem", { name: "Rename task canvas" }).click();
  const rename = page.getByRole("textbox", { name: "Task canvas name" });
  await rename.fill("Foundation Updated");
  await rename.press("Enter");
  await expect(foundation.getByText("Foundation Updated")).toBeVisible();
  const concurrency = page.getByRole("spinbutton", { name: "Max concurrent blocks" });
  await concurrency.fill("0");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await concurrency.fill("5");
  await page.getByRole("switch", { name: "Parallel execution" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.reload();
  await expect.poll(() => position(foundation)).toBe(moved);
  await expect(concurrency).toHaveValue("5");
  await expect(page.getByRole("switch", { name: "Parallel execution" })).not.toBeChecked();
  await page.getByRole("button", { name: "Reset Canvas Map layout" }).click();
  await expect.poll(() => position(foundation)).toBe(initial);
  await expect(foundation.getByText("Foundation Updated")).toBeVisible();
  await expect(concurrency).toHaveValue("5");
});

test("layout write failures show retry and can be saved without losing the drag", async ({ page }) => {
  await page.addInitScript((key) => {
    const setItem = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function (name, value) {
      if (!failed && name === key) { failed = true; throw new Error("Storage blocked for test"); }
      setItem.call(this, name, value);
    };
  }, layoutKey);
  await page.goto("/#/map");
  const foundation = node(page, "foundation");
  await expect(foundation).toBeVisible();
  await drag(page, foundation);
  const retry = page.getByRole("button", { name: "Retry save" });
  await expect(retry).toBeVisible();
  const moved = await position(foundation);
  await retry.click();
  await expect(retry).toHaveCount(0);
  await page.reload();
  await expect.poll(() => position(foundation)).toBe(moved);
});

test("narrow touchscreen layout and both themes run using only static assets", async ({ browser }, testInfo) => {
  const origin = "http://127.0.0.1:4178";
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, locale: "en-US", colorScheme: "dark" });
  const unexpected: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) return route.continue();
    unexpected.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => unexpected.push(error.message));
  const longTitle = `Verification-${"LongCanvasTitle".repeat(12)}`;
  await page.addInitScript((title) => {
    localStorage.setItem("planweave-demo/v1/release-workspace/name/verification", JSON.stringify(title));
  }, longTitle);
  await page.goto(`${origin}/#/map`);
  await expect(page.locator("html")).toHaveClass("dark");
  await expect(node(page, "foundation")).toBeVisible();
  await node(page, "delivery").tap({ position: { x: 20, y: 16 } });
  await expect(page.getByText("Execution policy", { exact: true })).toBeVisible();
  await node(page, "verification").tap({ position: { x: 20, y: 16 } });
  await expect(page.getByTestId("map-inspector").getByText(longTitle, { exact: true }).first()).toBeVisible();
  const aside = page.getByTestId("map-inspector").locator("[data-slot=scroll-area-viewport]");
  expect(await aside.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("map-narrow-dark.png"), animations: "disabled" });
  const projects = page.getByTestId("project-sidebar");
  await expect(projects).toBeHidden();
  await page.getByRole("button", { name: "Expand project sidebar" }).tap();
  await projects.getByRole("link", { name: "Todo" }).tap();
  await expect(projects).toBeHidden();
  await expect(page.getByRole("heading", { name: "Canvas phases" })).toBeVisible();
  await page.getByRole("button", { name: "Expand components" }).tap();
  await expect(page.getByTestId("component-palette")).toBeVisible();
  await page.getByRole("button", { name: "Collapse components" }).tap();
  await expect(page.getByTestId("component-palette")).toBeHidden();
  await page.getByRole("button", { name: "Use light theme" }).tap();
  await page.screenshot({ path: testInfo.outputPath("todo-narrow-light.png"), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  expect(unexpected).toEqual([]);
  await context.close();
});

test("desktop panes keep the upstream dimensions and fill the remaining space", async ({ page }) => {
  const projects = page.getByTestId("project-sidebar");
  const titlebar = page.getByTestId("workspace-titlebar");
  const inspector = page.getByTestId("map-inspector");
  const graph = page.locator(".react-flow");
  const palette = page.getByTestId("component-palette");
  const content = page.getByTestId("workspace-content");
  for (const width of [1100, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/map");
    await expect(graph).toBeVisible();
    expect(await projects.boundingBox()).toMatchObject({ x: 0, y: 0, width: 280, height: 900 });
    expect(await titlebar.boundingBox()).toMatchObject({ x: 280, y: 0, height: 44 });
    expect(await graph.boundingBox()).toMatchObject({ x: 280, y: 44, width: width - 600, height: 856 });
    expect(await inspector.boundingBox()).toMatchObject({ x: width - 320, y: 44, width: 320, height: 856 });
    await expect(palette).toHaveCount(0);
    await projects.getByRole("link", { name: "Todo" }).click();
    await expect(palette).toBeVisible();
    expect(await content.boundingBox()).toMatchObject({ x: 280, y: 44, width: width - 580 });
    expect(await palette.boundingBox()).toMatchObject({ x: width - 300, y: 0, width: 300, height: 900 });
    const todoViewport = page.getByTestId("todo-view").locator("[data-slot=scroll-area-viewport]");
    expect(await todoViewport.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  }
  await page.getByRole("button", { name: "Collapse components" }).click();
  await expect(palette).toBeHidden();
  expect(await content.boundingBox()).toMatchObject({ x: 280, width: 1640 });
  await page.getByRole("button", { name: "Expand components" }).click();
  await expect(palette).toBeVisible();
  await page.getByRole("button", { name: "Collapse project sidebar" }).click();
  await expect(projects).toBeHidden();
  expect(await content.boundingBox()).toMatchObject({ x: 0, width: 1620 });
  await page.getByRole("button", { name: "Expand project sidebar" }).click();
  await expect(projects).toBeVisible();
});

test("project tree locates canvases and tasks without cutting the full graph",  async ({ page }, testInfo) => {
  await page.goto("/#/todo");
  const sidebar = page.getByTestId("project-sidebar");
  await sidebar.getByRole("button", { name: /^Delivery / }).click();
  await expect(page).toHaveURL(/#\/graph\?canvas=delivery$/);
  const graph = page.getByTestId("task-graph");
  const task = (id: string) => graph.locator(`.react-flow__node[data-id="${id}"]`);
  const allNodes = graph.locator(".react-flow__node");
  await expect(allNodes).toHaveCount(5);
  await expect(graph.locator(".react-flow__edge")).toHaveCount(3);
  await expect(graph.locator(".react-flow__node.selected")).toHaveCount(2);
  const graphState = () => graph.evaluate((root) => ({
    nodes: Array.from(root.querySelectorAll<HTMLElement>(".react-flow__node"), (node) => [node.dataset.id, node.style.transform]).sort(),
    edges: Array.from(root.querySelectorAll(".react-flow__edge"), (edge) => edge.getAttribute("data-id")).sort()
  }));
  const initialGraph = await graphState();
  expect(initialGraph.edges).toContain("delivery:workspace->verification:quality");
  expect(initialGraph.edges).toContain("verification:quality->release:publish");
  const graphSurface = await graph.elementHandle();

  const row = sidebar.getByRole("button", { name: /^Canvas navigation/ });
  const target = task("delivery:navigation");
  const offsetFromCenter = async () => {
    const [surface, bounds] = await Promise.all([graph.boundingBox(), target.boundingBox()]);
    if (!surface || !bounds) return Infinity;
    return Math.max(Math.abs(bounds.x + bounds.width / 2 - surface.x - surface.width / 2),
      Math.abs(bounds.y + bounds.height / 2 - surface.y - surface.height / 2));
  };
  await row.press("Enter");
  await expect(target).toHaveClass(/\bselected\b/);
  await expect(row).toHaveAttribute("aria-current", "location");
  await expect.poll(offsetFromCenter).toBeLessThan(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await graphState()).toEqual(initialGraph);
  const surface = (await graph.boundingBox())!;
  await page.mouse.move(surface.x + surface.width / 2, surface.y + 70);
  await page.mouse.down();
  await page.mouse.move(surface.x + surface.width / 2 + 90, surface.y + 110, { steps: 5 });
  await page.mouse.up();
  await expect.poll(offsetFromCenter).toBeGreaterThan(50);
  await row.click();
  await expect.poll(offsetFromCenter).toBeLessThan(3);

  await target.getByRole("button", { name: /^Refine canvas navigation/ }).click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName("Refine canvas navigation");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(target).toHaveClass(/\bselected\b/);
  await page.screenshot({ path: testInfo.outputPath("task-graph-focused.png"), animations: "disabled" });

  await sidebar.getByRole("button", { name: /^Project foundation/ }).click();
  await expect(page).toHaveURL(/canvas=foundation&task=setup$/);
  await expect(task("foundation:setup")).toHaveClass(/\bselected\b/);
  expect(await graphState()).toEqual(initialGraph);
  expect(await graph.evaluate((element, original) => element.isSameNode(original), graphSurface)).toBe(true);
  await expect.poll(() => graph.evaluate((root) => {
    const pane = root.getBoundingClientRect();
    return Array.from(root.querySelectorAll(".react-flow__node"), (node) => node.getBoundingClientRect())
      .every((rect) => rect.left >= pane.left && rect.right <= pane.right && rect.top >= pane.top && rect.bottom <= pane.bottom);
  })).toBe(true);
  await page.goBack();
  await expect(target).toHaveClass(/\bselected\b/);
  await expect.poll(offsetFromCenter).toBeLessThan(3);
  await sidebar.getByRole("link", { name: "Release Workspace" }).click();
  await expect(page).toHaveURL(/#\/map$/);
  await expect(page.getByTestId("map-inspector")).toBeVisible();
});

test("desktop screenshots in both themes", async ({ page }, testInfo) => {
  for (const view of ["map", "todo"]) {
    await page.goto(`/#/${view}`);
    if (view === "map") await expect(node(page, "foundation")).toBeVisible();
    else await expect(page.getByRole("heading", { name: "Canvas phases" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${view}-desktop-light.png`), animations: "disabled" });
    await page.getByRole("button", { name: "Use dark theme" }).click();
    await page.screenshot({ path: testInfo.outputPath(`${view}-desktop-dark.png`), animations: "disabled" });
    await page.getByRole("button", { name: "Use light theme" }).click();
  }
});
