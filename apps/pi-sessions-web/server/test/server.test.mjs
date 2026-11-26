import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.mjs'
import { createApp } from '../src/main.mjs'
import { CANONICAL_ID, makeFixtureRoot } from './fixtures.mjs'

/** 起一个监听随机端口的实例，返回基址与关停函数。 */
async function start(root) {
  const config = {
    ...loadConfig({}, root),
    host: '127.0.0.1',
    port: 0,
    defaultRoot: root,
    stateFile: join(root, '.index.json'),
    prefsFile: join(root, '.prefs.json'),
    staticDir: join(root, '.web'),
    maxTextBytes: 4096,
  }
  const app = await createApp(config)
  const server = createServer((request, response) => {
    app.handle(request, response).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: String(error) }))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    app,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('列出根目录下的会话，明细补齐后再拉一次就完整', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })

  const first = await (await fetch(`${instance.base}/api/sessions?root=${encodeURIComponent(root)}`)).json()
  assert.equal(first.root, root)
  assert.equal(first.sessions.length, 5)
  assert.equal(first.truncated, false)
  assert.ok(first.pendingDetails > 0)

  await instance.app.scanner.whenIdle()
  const second = await (await fetch(`${instance.base}/api/sessions?root=${encodeURIComponent(root)}`)).json()
  assert.equal(second.pendingDetails, 0)
  const alpha = second.sessions.find((session) => session.id === CANONICAL_ID)
  assert.equal(alpha.messageCount, 3)
  assert.equal(alpha.projectName, 'alpha')
})

test('root 参数必须存在且是绝对路径的目录', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })

  const missing = await fetch(`${instance.base}/api/sessions`)
  assert.equal(missing.status, 400)
  assert.match((await missing.json()).error, /root/)

  const relative = await fetch(`${instance.base}/api/sessions?root=proj-alpha`)
  assert.equal(relative.status, 400)
  assert.match((await relative.json()).error, /绝对路径/)

  const notFound = await fetch(`${instance.base}/api/sessions?root=${encodeURIComponent('/nope/nope')}`)
  assert.equal(notFound.status, 400)
  assert.match((await notFound.json()).error, /不存在/)

  const file = await fetch(`${instance.base}/api/sessions?root=${encodeURIComponent(join(root, 'proj-gamma/notes.md'))}`)
  assert.equal(file.status, 400)
  assert.match((await file.json()).error, /不是目录/)
})

test('把根指向 ~/.pi/agent 这种上一级目录也能找到 sessions 子目录里的会话', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })
  const listing = await (await fetch(`${instance.base}/api/sessions?root=${encodeURIComponent(root)}`)).json()
  const ids = listing.sessions.map((session) => session.id)
  assert.ok(ids.includes(CANONICAL_ID))
})

test('单个会话的元信息带 tooLarge，并按 id 找得到', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })

  const response = await fetch(`${instance.base}/api/sessions/${CANONICAL_ID}?root=${encodeURIComponent(root)}`)
  assert.equal(response.status, 200)
  const meta = await response.json()
  assert.equal(meta.id, CANONICAL_ID)
  assert.equal(meta.format, 'pi')
  assert.equal(typeof meta.tooLarge, 'boolean')

  const missing = await fetch(`${instance.base}/api/sessions/nope?root=${encodeURIComponent(root)}`)
  assert.equal(missing.status, 404)
})

test('会话文本是组件库能直接解析的形状', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })

  const response = await fetch(`${instance.base}/api/sessions/${CANONICAL_ID}/text?root=${encodeURIComponent(root)}`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/plain/)
  const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines[0].type, 'session')
  assert.equal(lines[0].id, CANONICAL_ID)
  assert.equal(lines.filter((row) => row.type === 'message').length, 3)
})

test('老格式会话补出 session 头并保住父子关系', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })

  const listing = await (await fetch(`${instance.base}/api/sessions?root=${encodeURIComponent(root)}`)).json()
  const legacy = listing.sessions.find((session) => session.projectName === 'beta')
  const response = await fetch(
    `${instance.base}/api/sessions/${legacy.id}/text?root=${encodeURIComponent(root)}`,
  )
  const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines[0].type, 'session')
  assert.equal(lines[1].type, 'message')
  assert.equal(lines[1].id, 'u1')
  assert.equal(lines[2].parentId, 'u1')
})

test('文本支持 gzip，超过体积上限返回 413', async (t) => {
  const root = await makeFixtureRoot()
  const config = {
    ...loadConfig({}, root),
    defaultRoot: root,
    stateFile: join(root, '.index.json'),
    prefsFile: join(root, '.prefs.json'),
    staticDir: join(root, '.web'),
    maxTextBytes: 16,
  }
  const app = await createApp(config)
  const server = createServer((request, response) => void app.handle(request, response))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })

  // 上限 16 字节：任何会话都超，413 优先于内容输出
  const tooLarge = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${CANONICAL_ID}/text?root=${encodeURIComponent(root)}`,
  )
  assert.equal(tooLarge.status, 413)
  assert.match((await tooLarge.json()).error, /上限/)
})

test('文本按请求头 gzip 输出', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })
  const response = await fetch(
    `${instance.base}/api/sessions/${CANONICAL_ID}/text?root=${encodeURIComponent(root)}`,
    { headers: { 'Accept-Encoding': 'gzip' } },
  )
  assert.equal(response.headers.get('content-encoding'), 'gzip')
  const body = await response.text()
  assert.match(body, /"type":"session"/)
})

test('config 与 browse 给出初始根与子目录导航', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })

  const config = await (await fetch(`${instance.base}/api/config`)).json()
  assert.equal(config.defaultRoot, root)
  assert.ok(Array.isArray(config.suggestedRoots))
  assert.equal(typeof config.maxTextBytes, 'number')

  const browse = await (await fetch(`${instance.base}/api/browse?path=${encodeURIComponent(root)}`)).json()
  assert.equal(browse.path, root)
  assert.equal(browse.parent !== null, true)
  assert.deepEqual(
    browse.dirs.map((dir) => dir.name).sort(),
    ['proj-alpha', 'proj-beta', 'proj-delta', 'proj-gamma'],
  )
  assert.equal(browse.dirs.find((dir) => dir.name === 'proj-alpha').sessions, 1)

  const bad = await fetch(`${instance.base}/api/browse?path=${encodeURIComponent('/nope')}`)
  assert.equal(bad.status, 400)
})

test('索引落盘后重新启动不必再读文件内容', async (t) => {
  const root = await makeFixtureRoot()
  const first = await start(root)
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  await first.app.scanner.list(root)
  await first.app.scanner.whenIdle()
  first.app.persister.flush()
  await first.close()

  const second = await start(root)
  t.after(async () => {
    await second.close()
  })
  const listing = await (await fetch(`${second.base}/api/sessions?root=${encodeURIComponent(root)}`)).json()
  assert.equal(listing.pendingDetails, 0)
  assert.equal(listing.sessions.find((session) => session.id === CANONICAL_ID).messageCount, 3)
})

test('未知接口返回 404 JSON，未构建前端时根路径回 404 文本', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })

  const unknown = await fetch(`${instance.base}/api/nope`)
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error, '未知接口')

  const page = await fetch(`${instance.base}/`)
  assert.equal(page.status, 404)
  await page.text()

  const health = await fetch(`${instance.base}/api/health`)
  assert.equal(await health.text(), 'ok')
})

test('DELETE 删除会话并从后续列表里消失', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })

  const before = await (await fetch(`${instance.base}/api/sessions?root=${encodeURIComponent(root)}`)).json()
  assert.ok(before.sessions.some((session) => session.id === CANONICAL_ID))

  const url = `${instance.base}/api/sessions/${CANONICAL_ID}?root=${encodeURIComponent(root)}`
  const removed = await fetch(url, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  const body = await removed.json()
  assert.equal(body.id, CANONICAL_ID)
  assert.equal(body.removed.length, 1)

  const after = await (await fetch(`${instance.base}/api/sessions?root=${encodeURIComponent(root)}`)).json()
  assert.equal(after.sessions.some((session) => session.id === CANONICAL_ID), false)

  const again = await fetch(url, { method: 'DELETE' })
  assert.equal(again.status, 404)
})

test('偏好接口：GET 空列表，PUT 置顶与取消，非法请求体被拒', async (t) => {
  const root = await makeFixtureRoot()
  const instance = await start(root)
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })

  const empty = await (await fetch(`${instance.base}/api/prefs`)).json()
  assert.deepEqual(empty.pinnedProjects, [])

  const put = (body) =>
    fetch(`${instance.base}/api/prefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  assert.equal((await put({ pin: '/demo/alpha' })).status, 200)
  const pinned = await (await put({ pin: '/demo/beta' })).json()
  assert.deepEqual(pinned.pinnedProjects, ['/demo/beta', '/demo/alpha'])

  const unpinned = await (await put({ unpin: '/demo/beta' })).json()
  assert.deepEqual(unpinned.pinnedProjects, ['/demo/alpha'])

  const stored = await (await fetch(`${instance.base}/api/prefs`)).json()
  assert.deepEqual(stored.pinnedProjects, ['/demo/alpha'])

  assert.equal((await put({})).status, 400)
  assert.equal((await put({ pin: 42 })).status, 400)

  const broken = await fetch(`${instance.base}/api/prefs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  })
  assert.equal(broken.status, 400)
})
