#!/usr/bin/env node
import { serveExecutor } from 'ursi-executor-sdk';
import { runConfigSchema } from './node-contract.ts';
import { PiJobs } from './jobs.ts';

if (import.meta.main) {
	const jobs = new PiJobs();
	serveExecutor({
		name: 'ursi-pi-executor', version: '0.1.0', runConfigSchema,
		start: req => jobs.start(req), inspect: req => jobs.inspect(req), cancel: req => jobs.cancel(req),
	}).catch(() => { process.exitCode = 1; });
}
