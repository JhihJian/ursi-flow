/**
 * 联合验收夹具。只做三件事：准备隔离环境、启动真实进程、留下可复跑的证据。
 * 不拦截浏览器请求，所有业务调用都打到真实 ursi-server。
 *
 * 每次运行：
 * 1. 重建 web/acceptance/.run（临时数据目录、工作区、Pi 配置、日志、进程清单）。
 * 2. 生成新的 Bearer 令牌。
 * 3. 构建 Web 产物（URSI_ACCEPTANCE_SKIP_BUILD=1 可跳过）。
 * 4. 启动模拟模型端点、两台关闭 Flow 的真实 Server（一台关闭来源、一台配置 json-file 来源）、
 *    两台同源代理的预览服务。
 *
 * 清理见 global-teardown.ts。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { acceptanceDir, evidenceDir, pidsFile, runDir, runtimeFile, type Runtime } from './fixtures/runtime'
import { killAll, killStale } from './fixtures/cleanup'
import { origin, ports } from './fixtures/ports'

const webRoot = path.resolve(acceptanceDir, '..')
const viteBin = path.join(webRoot, 'node_modules/.bin/vite')

const logDir = path.join(runDir, 'logs')
const homeDir = path.join(runDir, 'home')
const piDir = path.join(runDir, 'pi')
const privateDir = path.join(runDir, 'private')
const modelLog = path.join(logDir, 'model-requests.jsonl')

interface Tracked { name: string; pid: number }

function track(entry: Tracked) {
  const previous: Tracked[] = existsSync(pidsFile) ? JSON.parse(readFileSync(pidsFile, 'utf8')) as Tracked[] : []
  writeFileSync(pidsFile, JSON.stringify([...previous, entry], null, 2))
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
  if (!child.pid) throw new Error(`${name} 未能启动`)
  track({ name, pid: child.pid })
  child.on('exit', (code, signal) => {
    // 收尾时我们主动发 SIGTERM，正常结束不算异常。
    if (signal || code === null || code === 0 || code === 130 || code === 143) return
    process.stderr.write(`${name} 退出码 ${code}，日志见 ${log}\n`)
  })
  return child
}

async function assertFree(port: number, label: string) {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error(`端口 ${port}（${label}）已被占用，请先停掉占用进程或改用环境变量指定其他端口`)))
    probe.once('listening', () => probe.close(() => resolve()))
    probe.listen(port, '127.0.0.1')
  })
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      if (await check()) return
      last = '未就绪'
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内未就绪：${last}`)
}

function serverEnv(token: string, dataDir: string, workspace: string, piBin: string, extra: Record<string, string> = {}) {
  // 白名单环境，不继承操作者的模型凭据。
  return {
    PATH: process.env.PATH ?? '',
    HOME: homeDir,
    LANG: 'C.UTF-8',
    PI_CODING_AGENT_DIR: piDir,
    URSI_API_TOKEN: token,
    URSI_DATA_DIR: dataDir,
    URSI_WORKSPACE_DIR: workspace,
    URSI_AGENT_BIN: piBin,
    URSI_FLOW_ENABLED: '0',
    URSI_FLOWD_BIN: path.join(runDir, 'absent-flowd'),
    ...extra,
  }
}

function writePrivate(file: string, body: string) {
  writeFileSync(file, body, { mode: 0o600 })
  chmodSync(file, 0o600)
}

export default async function globalSetup() {
  const token = randomBytes(32).toString('hex')
  // 上一次运行异常中断时留下的进程先收掉，避免端口被占。
  killStale()
  rmSync(runDir, { recursive: true, force: true })
  rmSync(evidenceDir, { recursive: true, force: true })
  for (const dir of [logDir, homeDir, piDir, privateDir, evidenceDir]) mkdirSync(dir, { recursive: true })
  chmodSync(privateDir, 0o700)
  writeFileSync(modelLog, '')
  writeFileSync(pidsFile, '[]')

  const serverBin = process.env.URSI_ACCEPTANCE_SERVER ?? '/data/dev/ursi-flow/target/debug/ursi-server'
  if (!existsSync(serverBin)) throw new Error(`找不到 Server 产物 ${serverBin}；先在 /data/dev/ursi-flow 执行 cargo build --locked -p ursi-server`)
  const piBin = process.env.URSI_ACCEPTANCE_PI ?? execFileSync('bash', ['-lc', 'command -v pi'], { encoding: 'utf8' }).trim()
  if (!piBin || !path.isAbsolute(piBin) || !existsSync(piBin)) throw new Error(`找不到真实 Pi CLI：${piBin}`)
  if (!existsSync(viteBin)) throw new Error(`找不到 vite：${viteBin}；不要安装依赖，检查 web/node_modules 软链`)

  for (const [port, label] of [
    [ports.mainApi, '主场景 Server'], [ports.sourcesApi, '来源专用 Server'],
    [ports.model, '模拟模型端点'], [ports.mainWeb, '主场景预览服务'], [ports.sourcesWeb, '来源专用预览服务'],
  ] as const) await assertFree(port, label)

  // Pi 只从这里读取模拟模型配置；模拟的是模型，不是执行器。
  const provider = {
    baseUrl: `${origin(ports.model)}/v1`,
    api: 'openai-completions',
    apiKey: 'simulated-key-only',
    models: [{ id: 'fixed-local-model' }],
  }
  writeFileSync(path.join(piDir, 'models.json'), JSON.stringify({ providers: { simulated: provider } }, null, 2))
  writeFileSync(path.join(piDir, 'settings.json'), JSON.stringify({ defaultProvider: 'simulated', defaultModel: 'fixed-local-model' }, null, 2))

  // 来源配置只指向本包要验证的工作包第 1 版与 inspect 动作。
  const ticketsFile = path.join(privateDir, 'tickets.json')
  writePrivate(ticketsFile, JSON.stringify([
    { id: 'T-1', title: '订单回执缺失', input: { ticket: 'T-1', symptom: '未收到回执' } },
    { id: 'T-2', title: '发票抬头错误', input: { ticket: 'T-2', symptom: '抬头与合同不一致' } },
  ], null, 2))
  const sourcesFile = path.join(privateDir, 'sources.json')
  writePrivate(sourcesFile, JSON.stringify({
    providers: [{ kind: 'json-file', id: 'tickets', file: ticketsFile, actions: [{ action: 'inspect', package: 'source-triage', revision: 1 }] }],
  }, null, 2))

  if (process.env.URSI_ACCEPTANCE_SKIP_BUILD !== '1') {
    execFileSync('npm', ['run', 'build'], { cwd: webRoot, stdio: 'inherit' })
  }

  try {
    launch('model', process.execPath, [path.join(acceptanceDir, 'fixtures/model-server.ts')], {
      cwd: webRoot,
      env: { ...process.env, MODEL_PORT: String(ports.model), MODEL_LOG: modelLog },
    })
    await waitFor('模拟模型端点', async () => (await fetch(`${origin(ports.model)}/health`)).ok, 15_000)

    const mainWorkspace = path.join(runDir, 'ws-main')
    const sourcesWorkspace = path.join(runDir, 'ws-sources')
    for (const dir of [mainWorkspace, sourcesWorkspace]) mkdirSync(dir, { recursive: true })

    launch('server-main', serverBin, [], {
      cwd: runDir,
      env: serverEnv(token, path.join(runDir, 'data-main'), mainWorkspace, piBin, {
        URSI_LISTEN_ADDR: `127.0.0.1:${ports.mainApi}`,
      }),
    })
    launch('server-sources', serverBin, [], {
      cwd: runDir,
      env: serverEnv(token, path.join(runDir, 'data-sources'), sourcesWorkspace, piBin, {
        URSI_LISTEN_ADDR: `127.0.0.1:${ports.sourcesApi}`,
        URSI_WORK_SOURCES: sourcesFile,
      }),
    })
    const authorized = (url: string) => fetch(`${url}/api/v2/items`, { headers: { Authorization: `Bearer ${token}` } })
    await waitFor('主场景 Server', async () => (await authorized(origin(ports.mainApi))).ok, 20_000)
    await waitFor('来源专用 Server', async () => (await authorized(origin(ports.sourcesApi))).ok, 20_000)

    for (const [name, webPort, apiPort] of [
      ['preview-main', ports.mainWeb, ports.mainApi],
      ['preview-sources', ports.sourcesWeb, ports.sourcesApi],
    ] as const) {
      launch(name, viteBin, ['preview', '--port', String(webPort), '--strictPort'], {
        cwd: webRoot,
        env: { ...process.env, URSI_API_PROXY: origin(apiPort) },
      })
    }
    const html = async (url: string) => (await fetch(url)).text()
    for (const [label, port] of [['主场景预览服务', ports.mainWeb], ['来源专用预览服务', ports.sourcesWeb]] as const) {
      await waitFor(label, async () => (await html(origin(port))).includes('<div id="root"'), 30_000)
    }
  } catch (cause) {
    // 启动失败也不能留下半套进程：停掉本次启动的子进程，日志留在 .run/logs 供排查。
    killAll()
    throw cause
  }

  const runtime: Runtime = {
    token,
    mainApi: origin(ports.mainApi),
    sourcesApi: origin(ports.sourcesApi),
    mainWeb: origin(ports.mainWeb),
    sourcesWeb: origin(ports.sourcesWeb),
    modelUrl: `${origin(ports.model)}/v1/chat/completions`,
    modelLog,
    piBin,
  }
  writeFileSync(runtimeFile, JSON.stringify(runtime, null, 2))
  process.stdout.write(`联合验收环境就绪：Web ${runtime.mainWeb} / ${runtime.sourcesWeb}，Server ${runtime.mainApi} / ${runtime.sourcesApi}\n`)
}
