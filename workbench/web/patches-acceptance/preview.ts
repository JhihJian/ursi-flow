/**
 * 一次性预览脚本：复用验收夹具拉起真实 Server + Web 预览，并种入演示数据。
 * 用法：npx tsx patches-acceptance/preview.ts
 * 停止：npx tsx patches-acceptance/preview.ts --stop
 */
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  acceptanceDir, dataDir, homeDir, logDir, runDir, workspaceDir,
} from './fixtures/paths'
import { host, origin, ports } from './fixtures/ports'
import { assertPortFree, killAll, killStale, startServer, startWeb } from './fixtures/process'
import { writeRuntime, type Runtime } from './fixtures/runtime'

const stopping = process.argv.includes('--stop')
if (stopping) {
  await killAll()
  process.exit(0)
}

await killStale()
rmSync(runDir, { recursive: true, force: true })
for (const dir of [logDir, dataDir, workspaceDir, homeDir, runDir]) mkdirSync(dir, { recursive: true })
for (const dir of [runDir, dataDir, workspaceDir, homeDir]) chmodSync(dir, 0o700)

const token = randomBytes(32).toString('hex')
const runtime: Runtime = {
  token,
  apiBase: origin(ports.api),
  webBase: origin(ports.web),
  apiPort: ports.api,
  webPort: ports.web,
  serverBin: path.join(acceptanceDir, '../../target/debug/ursi-server'),
  serverEnv: {
    PATH: process.env.PATH ?? '',
    HOME: homeDir,
    LANG: 'C.UTF-8',
    URSI_API_TOKEN: token,
    URSI_DATA_DIR: dataDir,
    URSI_WORKSPACE_DIR: workspaceDir,
    URSI_LISTEN_ADDR: `${host}:${ports.api}`,
    URSI_EXECUTOR_PLATFORM_URL: origin(1),
    URSI_EXECUTOR_PLATFORM_TOKEN: randomBytes(32).toString('hex'),
    URSI_AGENT_BIN: path.join(acceptanceDir, '.run/absent-agent'),
  },
  webEnv: {
    PATH: process.env.PATH ?? '',
    HOME: homeDir,
    URSI_API_PROXY: origin(ports.api),
  },
}
writeRuntime(runtime)
await assertPortFree(ports.api, '工作区 Server')
await assertPortFree(ports.web, 'Web 预览服务')

try {
  await startServer(runtime)
  await startWeb(runtime)
} catch (cause) {
  await killAll()
  throw cause
}

const api = `${runtime.apiBase}/api/v2`
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
async function json(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${await response.text()}`)
  return response.json() as Promise<Record<string, unknown>>
}

// 项目、画布与任务卡的变更都走 commands 接口，每次先取最新 revision。
const project = await json(`${api}/work-projects`, 'POST', { name: '演示 · 新版待办视图' }) as { id: string }
const base = `${api}/work-projects/${project.id}`
const revision = async () => (await json(`${base}/workspace`)).project.revision as number
const command = async (action: Record<string, unknown>) =>
  json(`${base}/commands`, 'POST', { revision: await revision(), ...action }) as Promise<{ id?: string }>
const canvasA = await command({ type: 'createCanvas', name: '材料准备' })
const canvasB = await command({ type: 'createCanvas', name: '客户沟通' })
const cardA1 = await command({ type: 'createTaskCard', canvasId: canvasA.id, name: '样本收集' })
const cardA2 = await command({ type: 'createTaskCard', canvasId: canvasA.id, name: '授权文件' })
const cardB1 = await command({ type: 'createTaskCard', canvasId: canvasB.id, name: '例会纪要' })
const create = (cardId: string, title: string, category: string) =>
  command({ type: 'createItem', taskCardId: cardId, title, description: `演示事项：${title}`, category })
const seeds: Array<{ id: string; title: string; category: string; status: string }> = [
  { title: '收齐三家的对比样本', category: 'one_time', status: 'completed', id: (await create(cardA1.id, '收齐三家的对比样本', 'one_time')).id! },
  { title: '确认冷链运输时效', category: 'one_time', status: 'active', id: (await create(cardA1.id, '确认冷链运输时效', 'one_time')).id! },
  { title: '补客户授权扫描件', category: 'continuous', status: 'pending', id: (await create(cardA2.id, '补客户授权扫描件', 'continuous')).id! },
  { title: '核对预算变更单', category: 'one_time', status: 'pending', id: (await create(cardA2.id, '核对预算变更单', 'one_time')).id! },
  { title: '整理本周例会结论', category: 'continuous', status: 'active', id: (await create(cardB1.id, '整理本周例会结论', 'continuous')).id! },
  { title: '排期下周客户回访', category: 'one_time', status: 'pending', id: (await create(cardB1.id, '排期下周客户回访', 'one_time')).id! },
]
// createItem 建出的条目固定是待开始，非待开始状态用工作项接口补状态。
for (const seed of seeds.filter(seed => seed.status !== 'pending')) {
  const item = await json(`${api}/work-items/${seed.id}`) as { title: string; description: string; category: string; revision: number }
  await json(`${api}/work-items/${seed.id}`, 'PUT', {
    title: item.title, description: item.description, category: item.category,
    status: seed.status, revision: item.revision,
  })
}

console.log(`预览已就绪：
  Web:   ${runtime.webBase}/work-projects/${project.id}/todo
  令牌:  ${token}
  停止:  npx tsx patches-acceptance/preview.ts --stop`)
