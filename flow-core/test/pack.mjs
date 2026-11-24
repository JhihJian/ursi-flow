import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const project = mkdtempSync(join(tmpdir(), "ursi-flow-core-pack-"));
const npm = (...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
	cwd: project,
	encoding: "utf8",
});
try {
	const [{ filename }] = JSON.parse(npm("pack", root.pathname, "--json"));
	npm("install", join(project, filename), "--offline", "--cache", join(project, "cache"), "--no-audit", "--no-fund");
	cpSync(new URL("test/core.test.mjs", root), join(project, "test/core.test.mjs"));
	cpSync(join(project, "node_modules/ursi-flow-core/examples"), join(project, "examples"), { recursive: true });
	writeFileSync(join(project, "consumer.mts"), `
import { ready, submit, type FlowContext, type StepResult } from "ursi-flow-core";
const { context } = ready("...");
const result: StepResult = { stepId: context.current!.stepId, outcome: "通过" };
const next: FlowContext = submit(context, result).context;
`);
	execFileSync(process.execPath, [new URL("node_modules/typescript/bin/tsc", root).pathname,
		"--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2022", "consumer.mts"],
	{ cwd: project, stdio: "inherit" });
	execFileSync(process.execPath, ["--test", "test/core.test.mjs"], { cwd: project, stdio: "inherit" });
} finally {
	rmSync(project, { recursive: true, force: true });
}
