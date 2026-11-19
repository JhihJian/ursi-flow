import { execFile, spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
export const home = join(root, '.e2e-home')
export const workdir = join(root, '.e2e-work')

export default async function setup() {
  await rm(home, { recursive: true, force: true })
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(workdir, { recursive: true })
  // Runtime 的 dist 不在版本库里，验收前先构建 daemon 及其 worker。
  await run('npm', ['run', 'build'], { cwd: join(root, '..') })
  // 验收跑的是命令节点，但启动运行要求 provider 已配置，这里给一份占位配置。
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      executor: 'local-pi',
      provider: {
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'e2e',
        model: 'e2e-fixture',
        api: 'openai-completions',
      },
      maxConcurrent: 4,
    }),
  )
  const daemon = spawn(process.execPath, [join(root, '..', 'dist', 'machine', 'daemon.js')], {
    env: { ...process.env, URSI_FLOW_HOME: home },
    stdio: 'ignore',
    detached: true,
  })
  daemon.unref()
  await writeFile(join(root, '.e2e-daemon.pid'), String(daemon.pid))
  const socket = join(home, 'runtime.sock')
  const { access } = await import('node:fs/promises')
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await access(socket)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('测试 daemon 未在 10 秒内启动')
}
