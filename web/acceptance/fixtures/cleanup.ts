/**
 * 进程清理。按 .run/pids.json 记录的进程组先 TERM 再 KILL，
 * 覆盖 Server、预览服务与模拟模型端点三类子进程。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pidsFile, runDir } from './runtime'

interface Tracked { name: string; pid: number }

function readTracked(): Tracked[] {
  if (!existsSync(pidsFile)) return []
  try { return JSON.parse(readFileSync(pidsFile, 'utf8')) as Tracked[] } catch { return [] }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 只清理本次运行记录的进程组，不动其他实例。 */
export function killAll() {
  const tracked = readTracked()
  const stopped: string[] = []
  for (const entry of tracked) {
    try {
      process.kill(-entry.pid, 'SIGTERM')
      stopped.push(entry.name)
    } catch { /* 已退出 */ }
  }
  // 给 Server 优雅退出的时间，再强制收尾。
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && tracked.some(entry => alive(-entry.pid))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  for (const entry of tracked) {
    try { process.kill(-entry.pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
  rmSync(pidsFile, { force: true })
  return stopped
}

/**
 * 收掉上一次异常中断留下的进程。只在命令行仍指向本次验收的产物时才动手，
 * 避免 PID 复用后误伤机器上的其他进程。
 */
export function killStale() {
  const tracked = readTracked().filter(entry => {
    try {
      return /ursi-server|vite|model-server/.test(readFileSync(`/proc/${entry.pid}/cmdline`, 'utf8'))
    } catch { return false }
  })
  for (const entry of tracked) {
    try { process.kill(-entry.pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
  rmSync(pidsFile, { force: true })
  return tracked.map(entry => entry.name)
}

/** 删除业务数据、工作区、Pi 配置与私有来源文件，保留日志供排查。 */
export function removeWorkDirs() {
  for (const name of ['data-main', 'data-sources', 'ws-main', 'ws-sources', 'home', 'pi', 'private']) {
    rmSync(path.join(runDir, name), { recursive: true, force: true })
  }
}
