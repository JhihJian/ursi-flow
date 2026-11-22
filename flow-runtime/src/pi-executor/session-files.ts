import { constants as fs, linkSync } from 'node:fs';
import { open, opendir, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

const directory = fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW;
const readOnly = fs.O_RDONLY | fs.O_NONBLOCK | fs.O_NOFOLLOW;
const fdPath = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`;

function segments(path: string) {
  const parts = path.split('/');
  if (parts.length > 64 || parts.some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f]/.test(p)))
    throw new Error('Invalid relative path');
  return parts;
}

// Pin every parent with O_NOFOLLOW. Checking realpath before an ordinary open would race renames.
async function descend(start: FileHandle, parts: string[]) {
  let dir = start;
  try {
    for (const part of parts) {
      const next = await open(fdPath(dir, part), directory);
      await dir.close();
      dir = next;
    }
    return dir;
  } catch (error) {
    await dir.close();
    throw error;
  }
}

export function openWorkspace(path: string) {
  if (!isAbsolute(path) || path === '/') throw new Error('Invalid workspace');
  const parts = segments(path.slice(1));
  return open('/', directory).then(root => descend(root, parts));
}

export async function openPolicyFile(path: string) {
  if (!isAbsolute(path)) throw new Error('Invalid policy path');
  const parts = segments(path.slice(1));
  const name = parts.pop()!;
  const dir = await descend(await open('/', directory), parts);
  try { return await open(fdPath(dir, name), readOnly); }
  finally { await dir.close(); }
}

export async function readBounded(file: FileHandle, limit: number) {
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('File not allowed');
  const buf = Buffer.alloc(limit + 1);
  let length = 0;
  while (length <= limit) {
    const { bytesRead } = await file.read(buf, length, buf.length - length, null);
    if (!bytesRead) return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, length));
    length += bytesRead;
  }
  throw new Error('File too large');
}

async function inputDir(workspace: FileHandle, parts: string[]) {
  return descend(await open(fdPath(workspace, 'inputs'), directory), parts);
}

export async function readInput(workspace: FileHandle, path: string) {
  const parts = segments(path);
  const name = parts.pop()!;
  const dir = await inputDir(workspace, parts);
  try {
    const file = await open(fdPath(dir, name), readOnly);
    try { return await readBounded(file, 256 * 1024); }
    finally { await file.close(); }
  } finally { await dir.close(); }
}

export async function listInputs(workspace: FileHandle, path: string) {
  const dir = await inputDir(workspace, path ? segments(path) : []);
  try {
    const names: string[] = [];
    let seen = 0;
    for await (const entry of await opendir(fdPath(dir, '.'))) {
      if (++seen > 256) throw new Error('Directory too large');
      if (entry.isFile() || entry.isDirectory()) names.push(entry.name + (entry.isDirectory() ? '/' : ''));
    }
    return JSON.stringify(names.sort());
  } finally { await dir.close(); }
}

export function publishAnswer(workspace: FileHandle, text: string, signal: AbortSignal) {
  return publishArtifact(workspace, 'answer.md', text, signal);
}

export async function publishArtifact(workspace: FileHandle, name: 'answer.md' | 'flow-outcome.json', text: string, signal: AbortSignal) {
  if (!text.trim() || Buffer.byteLength(text) > 1024 * 1024) throw new Error('Invalid final text');
  const dir = await open(fdPath(workspace, 'artifacts'), directory);
  const tmp = fdPath(dir, `.artifact-${randomUUID()}`);
  try {
    const file = await open(tmp, 'wx', 0o600);
    try {
      try { await file.writeFile(text, { signal }); }
      finally { await file.close(); }
      signal.throwIfAborted();
      // Commit without yielding after the last abort check. Never overwrite a prior attempt or link.
      linkSync(tmp, fdPath(dir, name));
    } finally { await unlink(tmp); }
  } finally { await dir.close(); }
}
