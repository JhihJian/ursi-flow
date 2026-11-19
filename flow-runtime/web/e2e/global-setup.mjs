import { execFile, spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
export const home = join(root, '.e2e-home')
export const workdir = join(root, '.e2e-work')
/** 运行的工作区根目录：启动时不指定工作目录的运行会在这里按 Run ID 建目录。 */
export const workspaces = join(root, '.e2e-workspaces')

export default async function setup() {
  await rm(home, { recursive: true, force: true })
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(workdir, { recursive: true })
  await rm(workspaces, { recursive: true, force: true })
  await mkdir(workspaces, { recursive: true })
  // Runtime 的 dist 不在版本库里，验收前先构建 daemon 及其 worker。
  await run('npm', ['run', 'build'], { cwd: join(root, '..') })
  // 命令节点也要求 provider 已配置；Agent 用例由本地 OpenAI 兼容 fixture 应答。
  const model = spawn(process.execPath, [join(root, 'e2e', 'model-fixture.mjs')], {
    env: { ...process.env, MODEL_FIXTURE_PORT: '14485' },
    stdio: 'ignore',
    detached: true,
  })
  model.unref()
  await writeFile(join(root, '.e2e-model.pid'), String(model.pid))
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      executor: 'local-pi',
      provider: {
        baseUrl: 'http://127.0.0.1:14485/v1',
        apiKey: 'e2e',
        model: 'e2e-fixture',
        api: 'openai-completions',
      },
      maxConcurrent: 4,
      workspace: workspaces,
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
