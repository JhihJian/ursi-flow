#!/usr/bin/env node
import { McpStdioServer, runStdio } from "../integrations/mcp/stdio.ts";
import { PiJobs } from "./jobs.ts";

if (import.meta.main) {
	runStdio(process.stdin, process.stdout, new McpStdioServer(new PiJobs(), "ursi-pi-executor"))
		.catch(() => { process.exitCode = 1; });
}
