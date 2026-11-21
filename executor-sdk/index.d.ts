import type { Readable, Writable } from 'node:stream';
export const LEGACY_VERSION: '2025-06-18';
export const MODERN_VERSION: '2026-07-28';
export type ExecutorStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unverified';
export type ExecutorErrorCode = 'invalid' | 'conflict' | 'not_found' | 'busy' | 'unavailable';
export class ExecutorError extends Error { readonly code: ExecutorErrorCode; constructor(code: ExecutorErrorCode); }
export interface AttemptRequest { attemptId: string }
export interface ExecutorStartRequest extends AttemptRequest {
  workspaceRef: `workspace:${string}`; artifactDirectoryRef: `artifacts:${string}`;
  workInstruction: string; runConfig?: Record<string, unknown>;
}
export interface ExecutorResult extends AttemptRequest { status: ExecutorStatus; artifactDirectoryRef: string; backendRunRef?: string }
export interface ExecutorBackend {
  start(req: ExecutorStartRequest): ExecutorResult | Promise<ExecutorResult>;
  inspect(req: AttemptRequest): ExecutorResult | Promise<ExecutorResult>;
  cancel(req: AttemptRequest): ExecutorResult | Promise<ExecutorResult>;
}
export interface ExecutorOptions extends ExecutorBackend { name: string; version: string; runConfigSchema?: Record<string, unknown> }
export interface ExecutorServer { handle(request: unknown): Promise<unknown> }
export function createExecutorServer(options: ExecutorOptions): ExecutorServer;
export function runStdio(input: Readable, output: Writable, server: ExecutorServer): Promise<void>;
export function serveExecutor(options: ExecutorOptions): Promise<void>;
export function parseStartRequest(value: unknown): ExecutorStartRequest;
export function parseAttemptRequest(value: unknown): AttemptRequest;
