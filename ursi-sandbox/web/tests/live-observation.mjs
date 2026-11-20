// Run with an ordinary user: node tests/live-observation.mjs (after npm run build).
// Only the Python fixture needs privilege. No existing URLs, keys or IDs are accepted.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createConsole } from '../server.mjs'

const fixtureFile = fileURLToPath(
  new URL('./live-observation-fixture.py', import.meta.url),
)
let stage = 'preflight',
  browser,
  server,
  child,
  closed,
  interrupted = false
function interrupt() {
  interrupted = true
  child?.stdin.end()
  browser?.close().catch(() => {})
}
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

async function test() {
  assert.equal(process.platform, 'linux')
  assert.notEqual(
    process.getuid(),
    0,
    'Run Node and Chromium as an ordinary user',
  )
  await access(new URL('../dist/index.html', import.meta.url))
  stage = 'launch Chromium'
  browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false })
  assert.ok(!interrupted)
  stage = 'create isolated Docker fixture'
  child = spawn('sudo', ['-n', '/usr/bin/python3', '-I', '-B', fixtureFile], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    detached: true, // parent handles Ctrl-C; EOF asks fixture to clean up
  })
  closed = new Promise((resolve) => {
    child.once('error', () => resolve(1))
    child.once('close', (code) => resolve(code ?? 1))
  })
  child.stdin.on('error', () => {}) // early fixture exit: EOF and exit code report failure
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const receive = async () => {
    const { done, value } = await lines.next()
    assert.ok(!done && !interrupted, 'fixture unavailable')
    return JSON.parse(value)
  }
  const key = randomBytes(32).toString('hex')
  child.stdin.write(key + '\n')
  const { port, sandbox } = await receive()
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536)
  assert.match(sandbox, /^[0-9a-f]{32}$/)
  const admin = randomBytes(32).toString('hex')
  server = createConsole({
    URSI_GATEWAY_URL: `http://127.0.0.1:${port}`,
    URSI_GATEWAY_KEY: key,
    URSI_WEB_ADMIN_PASSWORD: admin,
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const page = await browser.newPage({
    acceptDownloads: true,
    serviceWorkers: 'block',
    httpCredentials: { username: 'admin', password: admin, origin },
  })
  page.setDefaultTimeout(25_000)
  const obs = `${origin}/api/v1/sandboxes/${sandbox}/observations`
  const button = (name) => page.getByRole('button', { name, exact: true })
  const action = (name, url) =>
    Promise.all([
      page.waitForResponse(
        (r) => r.url() === url && r.request().method() === 'POST',
      ),
      button(name).click(),
    ]).then(([response]) => {
      assert.equal(response.status(), 202)
      return response.json()
    })

  stage = 'open 网络观测 from sandbox details'
  await page.goto(`${origin}/#/sandboxes/${sandbox}`)
  await expect(page.getByTestId('instance-status')).toHaveText('运行中')
  await page.getByText('网络观测', { exact: true }).click()
  stage = '开始观测'
  const rec = await action('开始观测', obs)
  const run = rec.observation_id
  assert.equal(rec.sandbox_id, sandbox)
  assert.match(run, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  await page.waitForURL(`${origin}/#/sandboxes/${sandbox}/observations/${run}`)
  stage = 'refresh observation and generate scoped traffic'
  await page.reload()
  await expect(button('停止观测')).toBeEnabled({ timeout: 25_000 })
  child.stdin.write(run + '\n')
  const { peer } = await receive()

  stage = '停止观测 and wait for final PCAP'
  await action('停止观测', `${obs}/${run}/stop`)
  child.stdin.write('stopped\n')
  const { size, sha256 } = await receive()
  stage = '预览: verify loopback and peer packet rows'
  const packets = page.getByRole('region', { name: '报文明细' })
  await packets.getByRole('button', { name: /^预览(?:分段)?$/ }).click()
  for (const address of ['127.0.0.1', peer]) {
    await expect(
      packets.getByRole('row').filter({ hasText: address }).first(),
    ).toBeVisible({ timeout: 25_000 })
  }
  await packets
    .getByRole('combobox', { name: /方向/ })
    .selectOption({ label: '发出' })
  await expect(
    packets.getByRole('cell', { name: '发出', exact: true }).first(),
  ).toBeVisible()
  await expect(
    packets.getByRole('cell', { name: '本机接收', exact: true }),
  ).toHaveCount(0)
  stage = 'download and compare with original Gateway segment'
  const downloadControl = packets.getByRole('link', { name: '下载完整分段' })
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadControl.click(),
  ])
  const data = await readFile(await download.path())
  assert.equal(data.length, size)
  assert.equal(createHash('sha256').update(data).digest('hex'), sha256)
}

try {
  await test()
} catch (error) {
  // Playwright call logs / assertion diffs can include page content. Do not dump them.
  console.error(`FAIL: ${stage} (${error.name})`)
  process.exitCode = 1
} finally {
  child?.stdin.end()
  try {
    await browser?.close()
  } finally {
    server?.closeAllConnections()
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    if ((closed && (await closed) !== 0) || interrupted) process.exitCode = 1
  }
}
if (!process.exitCode)
  console.log(
    'PASS: start, refresh, stop, preview, verified PCAP download and cleanup',
  )
