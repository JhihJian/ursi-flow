/**
 * 真实进程管理：只启动本机 Server 与 Web 预览服务，不启动任何模型、Pi 或守护进程。
 * 进程按记录的进程组先 TERM 再 KILL；重启复用保存的启动环境。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { dataDir, homeDir, logDir, viteBin, webRoot, workspaceDir } from './paths'
import { readPids, readRuntime, writePids, type Runtime, type Tracked } from './runtime'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

export function track(entry: Tracked) {
  writePids([...readPids().filter(item => item.name !== entry.name), entry])
}

function untrack(name: string) {
  writePids(readPids().filter(item => item.name !== name))
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {
    /* 已退出 */
  }
}

async function stopGroup(name: string) {
  const entries = readPids().filter(item => item.name === name)
  for (const entry of entries) killGroup(entry.pid, 'SIGTERM')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && entries.some(entry => groupAlive(entry.pid))) await sleep(100)
  for (const entry of entries) killGroup(entry.pid, 'SIGKILL')
  untrack(name)
}

/** 停止本次记录的 Server 与 Web 进程。 */
export async function killAll() {
  const names = [...new Set(readPids().map(entry => entry.name))]
  const stopped: string[] = []
  for (const name of names) {
    await stopGroup(name)
    stopped.push(name)
  }
  writePids([])
  return stopped
}

/** 旧记录不能证明进程仍归本次验收所有，不按可能复用的 PID 发送信号。 */
export async function killStale() {
  if (readPids().some(entry => alive(entry.pid))) {
    throw new Error('发现仍存活的旧验收进程，请确认其身份并停止后重试。')
  }
  writePids([])
}

export function removeWorkDirs() {
  rmSync(workspaceDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
}

export async function assertPortFree(port: number, label: string) {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error(`端口 ${port}（${label}）已被占用，请先停掉占用进程或改用环境变量指定其他端口`)))
    probe.once('listening', () => probe.close(() => resolve()))
    probe.listen(port, '127.0.0.1')
  })
}

export async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let last = '未就绪'
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause)
    }
    await sleep(100)
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内未就绪：${last}`)
}

function launch(name: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const log = path.join(logDir, `${name}.log`)
  const fd = openSync(log, 'a')
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  if (!child.pid) throw new Error(`${name} 未能启动`)
  track({ name, pid: child.pid })
  child.on('exit', (code, signal) => {
    // 收尾时主动发信号，正常结束不算异常。
    if (signal || code === null || code === 0 || code === 130 || code === 143) return
    process.stderr.write(`${name} 退出码 ${code}，日志见 ${log}\n`)
  })
  return child
}

async function workspaceTypesReady(runtime: Runtime) {
  const response = await fetch(`${runtime.apiBase}/api/v2/workspace-types`, {
    headers: { Authorization: `Bearer ${runtime.token}` },
  })
  if (response.status === 200) return true
  if (response.status === 404) {
    throw new Error('Server 没有 /api/v2/workspace-types；先在 workbench/ 执行 cargo build --locked -p ursi-server')
  }
  throw new Error(`HTTP ${response.status}`)
}

export async function startServer(runtime: Runtime) {
  launch('server', runtime.serverBin, [], { cwd: logDir, env: { ...runtime.serverEnv } })
  await waitFor('工作区 Server', () => workspaceTypesReady(runtime), 25_000)
}

export async function stopServer() {
  await stopGroup('server')
}

export async function restartServer() {
  const runtime = readRuntime()
  await stopServer()
  await assertPortFree(runtime.apiPort, '工作区 Server')
  await startServer(runtime)
}

export async function startWeb(runtime: Runtime) {
  launch('web', viteBin, ['preview', '--port', String(runtime.webPort), '--strictPort'], {
    cwd: webRoot,
    env: { ...runtime.webEnv },
  })
  await waitFor('Web 预览服务', async () => (await fetch(runtime.webBase)).text().then(html => html.includes('<div id="root"')), 30_000)
}
