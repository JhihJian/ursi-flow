import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlowDefinition, LoadedFlow } from "../contracts/types.ts";
import { loadFlow } from "./flow-loader.ts";

export interface FlowListing {
	id: string;
	name: string;
	description: string;
	path: string;
}

export type FlowScope = "project" | "user";

export interface AvailableFlow extends FlowListing {
	scope: FlowScope;
	variables: FlowDefinition["variables"];
	capabilities: FlowDefinition["capabilities"];
}

export interface FlowCatalogIssue {
	scope: FlowScope;
	path: string;
	error: string;
}

export interface FlowCatalogResult {
	flows: AvailableFlow[];
	issues: FlowCatalogIssue[];
}

export const PROJECT_FLOW_DIRECTORY = ".flows";

export function userFlowDirectory(homeDirectory = homedir()): string {
	return join(homeDirectory, ".pi", "agent", "flows");
}

/** Resolves the fixed project and user Flow roots used by Pi tools. */
export function flowDirectories(
	cwd: string,
	homeDirectory = homedir(),
): Array<{ scope: FlowScope; path: string }> {
	return [
		{ scope: "project", path: join(cwd, PROJECT_FLOW_DIRECTORY) },
		{ scope: "user", path: userFlowDirectory(homeDirectory) },
	];
}

/** Discovers valid Flow packages from the fixed project and user roots. */
export async function listAvailableFlows(
	cwd: string,
	homeDirectory = homedir(),
): Promise<FlowCatalogResult> {
	const flows: AvailableFlow[] = [];
	const issues: FlowCatalogIssue[] = [];
	for (const root of flowDirectories(cwd, homeDirectory)) {
		const discovered = await discoverAvailableFlows(
			root.path,
			root.scope,
			issues,
		);
		const ids = new Set<string>();
		for (const flow of discovered) {
			if (ids.has(flow.id)) {
				issues.push({
					scope: root.scope,
					path: flow.path,
					error: `发现重复 Flow 标识: ${flow.id}`,
				});
				continue;
			}
			ids.add(flow.id);
			flows.push(flow);
		}
	}
	return {
		flows: flows
			.filter(
				(flow, _index, all) =>
					flow.scope === "project" ||
					!all.some(
						(candidate) =>
							candidate.scope === "project" && candidate.id === flow.id,
					),
			)
			.sort((left, right) => left.id.localeCompare(right.id)),
		issues,
	};
}

export async function resolveAvailableFlow(
	id: string,
	cwd: string,
	homeDirectory = homedir(),
): Promise<AvailableFlow> {
	const result = await listAvailableFlows(cwd, homeDirectory);
	const flow = result.flows.find((candidate) => candidate.id === id);
	if (flow) return flow;
	const issue = result.issues.find((candidate) => candidate.path.includes(id));
	if (issue) throw new Error(`Flow ${id} 无法加载: ${issue.error}`);
	throw new Error(`Flow 不存在: ${id}`);
}

async function discoverAvailableFlows(
	directory: string,
	scope: FlowScope,
	issues: FlowCatalogIssue[],
): Promise<AvailableFlow[]> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		(error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		},
	);
	const flows: AvailableFlow[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		if (!entry.isDirectory()) continue;
		if (entry.name === "references" || entry.name === "scripts") continue;
		const path = join(directory, entry.name);
		const children = await readdir(path, { withFileTypes: true });
		if (children.some((child) => child.isFile() && child.name === "FLOW.md")) {
			try {
				const loaded = await loadFlow(path);
				flows.push({
					id: loaded.flow.id,
					name: loaded.flow.name,
					description: loaded.flow.description,
					path: loaded.path,
					scope,
					variables: loaded.flow.variables,
					capabilities: loaded.flow.capabilities,
				});
			} catch (error) {
				issues.push({
					scope,
					path: join(path, "FLOW.md"),
					error: error instanceof Error ? error.message : String(error),
				});
			}
			continue;
		}
		flows.push(...(await discoverAvailableFlows(path, scope, issues)));
	}
	return flows;
}

/** Discovers directory-based Flow packages without owning runtime state. */
export class FlowDirectory {
	private readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
	}

	async list(): Promise<FlowListing[]> {
		const flows = await this.discover(this.directory);
		const ids = new Set<string>();
		return flows
			.sort((left, right) => left.flow.id.localeCompare(right.flow.id))
			.map((loaded) => {
				if (ids.has(loaded.flow.id)) {
					throw new Error(`发现重复 Flow 标识: ${loaded.flow.id}`);
				}
				ids.add(loaded.flow.id);
				return {
					id: loaded.flow.id,
					name: loaded.flow.name,
					description: loaded.flow.description,
					path: loaded.path,
				};
			});
	}

	async load(id: string): Promise<FlowDefinition> {
		const listing = (await this.list()).find(
			(candidate) => candidate.id === id,
		);
		if (!listing) throw new Error(`Flow 不存在: ${id}`);
		return (await loadFlow(listing.path)).flow;
	}

	private async discover(directory: string): Promise<LoadedFlow[]> {
		const entries = await readdir(directory, { withFileTypes: true });
		const flows: LoadedFlow[] = [];
		for (const entry of entries.sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "references" || entry.name === "scripts") continue;
			const path = join(directory, entry.name);
			const children = await readdir(path, { withFileTypes: true });
			if (
				children.some((child) => child.isFile() && child.name === "FLOW.md")
			) {
				flows.push(await loadFlow(path));
				continue;
			}
			flows.push(...(await this.discover(path)));
		}
		return flows;
	}
}
