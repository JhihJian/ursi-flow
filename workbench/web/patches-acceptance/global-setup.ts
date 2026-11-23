/**
 * 工作包与配置包联合验收夹具：真实 Web 构建产物 + 真实 Rust Server。
 *
 * 隔离边界：
 * - 临时数据目录、工作区、HOME 和日志全部在 patches-acceptance/.run/ 内。
 * - Server 以白名单环境启动，Flow 关闭，不配置 Pi、模型、来源或沙箱。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  acceptanceDir, dataDir, defaultServerBin, evidenceDir, homeDir,
  logDir, runDir, viteBin, webRoot, workspaceDir,
} from './fixtures/paths'
import { host, origin, ports } from './fixtures/ports'
import { assertPortFree, killAll, killStale, startServer, startWeb } from './fixtures/process'
import { writeRuntime, type Runtime } from './fixtures/runtime'

function serverBinary() {
  const override = process.env.URSI_PATCHES_ACCEPTANCE_SERVER
  return override ? path.resolve(override) : defaultServerBin
}

export default async function globalSetup() {
  await killStale()
  rmSync(runDir, { recursive: true, force: true })
  rmSync(evidenceDir, { recursive: true, force: true })
  for (const dir of [logDir, dataDir, workspaceDir, homeDir, evidenceDir]) mkdirSync(dir, { recursive: true })
  // 工作数据目录必须为服务账户私有目录，Store::open 会校验权限位。
  for (const dir of [runDir, dataDir, workspaceDir, homeDir]) chmodSync(dir, 0o700)

  const serverBin = serverBinary()
  if (!existsSync(serverBin)) {
    throw new Error(`找不到 Server 产物 ${serverBin}；先在 workbench/ 执行 cargo build --locked -p ursi-server`)
  }
  if (!existsSync(viteBin)) {
    throw new Error(`找不到 vite：${viteBin}；不要安装依赖，检查 web/node_modules`)
  }

  if (process.env.URSI_PATCHES_SKIP_BUILD !== '1') {
    execFileSync('npm', ['run', 'build'], { cwd: webRoot, stdio: 'inherit' })
  }
  if (!existsSync(path.join(webRoot, 'dist/index.html'))) {
    throw new Error('缺少 Web 构建产物 dist/index.html；先执行 npm run build，或不要设置 URSI_PATCHES_SKIP_BUILD')
  }

  await assertPortFree(ports.api, '工作区 Server')
  await assertPortFree(ports.web, 'Web 预览服务')

  const token = randomBytes(32).toString('hex')
  const runtime: Runtime = {
    token,
    apiBase: origin(ports.api),
    webBase: origin(ports.web),
    apiPort: ports.api,
    webPort: ports.web,
    serverBin,
    dataDir,
    workspaceDir,
    homeDir,
    // 白名单环境：不继承操作者的模型凭据，也不挂载任何外部执行能力。
    serverEnv: {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      LANG: 'C.UTF-8',
      URSI_API_TOKEN: token,
      URSI_DATA_DIR: dataDir,
      URSI_WORKSPACE_DIR: workspaceDir,
      URSI_LISTEN_ADDR: `${host}:${ports.api}`,
      // 本地功能无需平台在线，但 Server 启动时要求显式配置地址和令牌。
      URSI_EXECUTOR_PLATFORM_URL: origin(1),
      URSI_EXECUTOR_PLATFORM_TOKEN: randomBytes(32).toString('hex'),
      URSI_FLOW_ENABLED: '0',
      URSI_FLOWD_BIN: path.join(acceptanceDir, '.run/absent-flowd'),
      URSI_AGENT_BIN: path.join(acceptanceDir, '.run/absent-agent'),
    },
    webEnv: {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      URSI_API_PROXY: origin(ports.api),
    },
  }
  writeRuntime(runtime)

  try {
    await startServer(runtime)
    await startWeb(runtime)
  } catch (cause) {
    await killAll()
    throw cause
  }

  process.stdout.write(`工作包与配置包验收环境就绪：Web ${runtime.webBase}，Server ${runtime.apiBase}\n`)
}
