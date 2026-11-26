import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJsonc, stripJsonComments } from './jsonc.ts'
import { readSnapshotSync, writeSnapshot, ConflictError } from './rw.ts'
import { readSettings, mutateSettings } from './settings-file.ts'
import { toggleDisableModelInvocation, readDisableModelInvocation } from './skills.ts'
import { readMcp, maskSecret } from './mcp-file.ts'
import { readModels, readAuth, mergeAuth, readModelCatalog } from './models-auth.ts'
import { readCachedCatalog } from './models-runtime.ts'
import { createHash } from 'node:crypto'
import { listPackages, applyPackagesMutation } from './plugins.ts'
import { listAgentProfiles, readAgentsSettings, writeAgentsSettings, renderProfile, saveAgentProfile } from './agents.ts'

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-manager-test-'))
  writeFileSync(join(dir, 'settings.json'), '{}\n')
  return dir
}

// ---------------------------------------------------------------------------
// jsonc
// ---------------------------------------------------------------------------

test('jsonc 剥 BOM 与注释，字符串内的 // 保留', () => {
  const text = '\uFEFF{\n  // 行注释\n  "a": "http://x", /* 块注释 */\n  "b": 1\n}'
  assert.deepEqual(parseJsonc<Record<string, unknown>>(text), { a: 'http://x', b: 1 })
})

test('空 jsonc 读为空对象', () => {
  assert.deepEqual(parseJsonc(''), {})
  assert.deepEqual(parseJsonc('\uFEFF// only a comment\n'), {})
})

// ---------------------------------------------------------------------------
// rw 乐观锁与备份
// ---------------------------------------------------------------------------

test('writeSnapshot revision 不匹配抛 ConflictError', async () => {
  const dir = makeHome()
  const file = join(dir, 'settings.json')
  const snap = readSnapshotSync(file, JSON.parse)
  writeFileSync(file, '{"changed": true}\n')
  await assert.rejects(
    writeSnapshot(file, snap.revision, () => '{}'),
    ConflictError,
  )
})

test('writeSnapshot 成功时生成 .bak-manager', async () => {
  const dir = makeHome()
  const file = join(dir, 'settings.json')
  const snap = readSnapshotSync(file, JSON.parse)
  await writeSnapshot(file, snap.revision, () => '{"next": 1}\n')
  const bak = readFileSync(`${file}.bak-manager`, 'utf8')
  assert.equal(bak, '{}\n')
  assert.equal(readFileSync(file, 'utf8'), '{"next": 1}\n')
})

// ---------------------------------------------------------------------------
// settings.json 受管 key 写入
// ---------------------------------------------------------------------------

test('mutateSettings 只动目标 key，未知 key 保留', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    defaultModel: { provider: 'a', modelId: 'b' },
    customFutureKey: { nested: [1, 2] },
  }))
  const snap = readSettings(dir)
  const result = mutateSettings(dir, snap.revision, (settings) => {
    settings.defaultThinkingLevel = 'high'
    return true
  })
  assert.equal(result.changed, true)
  const after = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  assert.equal(after.defaultThinkingLevel, 'high')
  assert.deepEqual(after.customFutureKey, { nested: [1, 2] })
  assert.deepEqual(after.defaultModel, { provider: 'a', modelId: 'b' })
})

test('mutateSettings revision 过期拒绝', () => {
  const dir = makeHome()
  const snap = readSettings(dir)
  writeFileSync(join(dir, 'settings.json'), '{"x": 1}')
  assert.throws(() => mutateSettings(dir, snap.revision, () => true), ConflictError)
})

test('mutateSettings 写回不带结尾换行（与 pi 自身写法一致）', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), '{\n  "theme": "dark"\n}')
  const snap = readSettings(dir)
  mutateSettings(dir, snap.revision, (settings) => {
    settings.enabledModels = ['p/m']
    return true
  })
  const text = readFileSync(join(dir, 'settings.json'), 'utf8')
  assert.equal(text.endsWith('\n'), false)
  assert.deepEqual(JSON.parse(text), { theme: 'dark', enabledModels: ['p/m'] })
})

// ---------------------------------------------------------------------------
// skills frontmatter 外科切换
// ---------------------------------------------------------------------------

function makeSkill(body: string): string {
  return `---\nname: demo\ndescription: A test skill\n${body}---\n\n# Demo\n\n正文。`
}

test('skills：无该 key 时追加一行，其余字节不变', () => {
  const original = makeSkill('')
  const next = toggleDisableModelInvocation(original, true)
  assert.ok(next.startsWith('---\nname: demo\ndescription: A test skill\ndisable-model-invocation: true\n---'))
  assert.ok(next.includes('# Demo'))
  // 除了插入的一行，其他内容逐字节一致
  assert.equal(next.replace('disable-model-invocation: true\n', ''), original)
})

test('skills：true 改回删除整行，CRLF 保持', () => {
  const original = makeSkill('disable-model-invocation: true\n').replace(/\n/g, '\r\n')
  const next = toggleDisableModelInvocation(original, false)
  assert.ok(!next.includes('disable-model-invocation'))
  assert.ok(next.includes('\r\n'))
})

test('skills：false 值改为 true 时只改该行', () => {
  const original = makeSkill('disable-model-invocation: false\n')
  const next = toggleDisableModelInvocation(original, true)
  assert.ok(next.includes('disable-model-invocation: true'))
  assert.equal(next.split('\n').length, original.split('\n').length)
})

test('skills：嵌套同名 key 不受影响', () => {
  const text = '---\nname: demo\nmetadata:\n  disable-model-invocation: true\n---\n正文'
  const next = toggleDisableModelInvocation(text, false)
  // 根级本来就没有该 key，删除是 no-op
  assert.equal(next, text)
})

test('skills：readDisableModelInvocation 识别布尔', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-skill-'))
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, makeSkill('disable-model-invocation: true\n'))
  assert.equal(readDisableModelInvocation(file), true)
  writeFileSync(file, makeSkill(''))
  assert.equal(readDisableModelInvocation(file), false)
})

// ---------------------------------------------------------------------------
// mcp 遮蔽与标注
// ---------------------------------------------------------------------------

test('mcp：字面量密钥遮蔽、${VAR} 与 !command 标注但不改写', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
    'fs-web': {
      command: 'npx',
      args: ['-y', 'fs-mcp'],
      env: { API_KEY: 'sk-ant-1234567890abcdef' },
    },
    remote: {
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${MY_TOKEN}' },
    },
    shell: {
      command: '!echo generate-token',
      type: 'stdio',
    },
  }))
  const listing = readMcp(dir)
  const fsEntry = listing.servers.find((s) => s.name === 'fs-web')
  assert.ok(fsEntry)
  const env = fsEntry.entry.env as Record<string, string>
  assert.ok(env.API_KEY.startsWith('•••'))
  assert.ok(!env.API_KEY.includes('sk-ant-1234567890'))
  assert.ok(fsEntry.maskedFields.includes('env.API_KEY'))

  const remote = listing.servers.find((s) => s.name === 'remote')
  assert.ok(remote)
  const headers = remote.entry.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer ${MY_TOKEN}')
  assert.ok(remote.varRefs.includes('headers.Authorization'))

  const shell = listing.servers.find((s) => s.name === 'shell')
  assert.ok(shell)
  assert.ok(shell.commandValues.includes('command'))
  assert.equal((shell.entry as Record<string, string>).command, '!echo generate-token')
})

test('maskSecret 短值不泄露末尾', () => {
  assert.equal(maskSecret('abc'), '•••')
  assert.ok(maskSecret('verylongsecret').includes('cret'))
})

// ---------------------------------------------------------------------------
// models.json 与 auth.json
// ---------------------------------------------------------------------------

test('models：JSONC 读入、apiKey 遮蔽、模型计数', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'models.json'), '\uFEFF// 自定义提供商\n{\n  "providers": {\n    "my-provider": {\n      "baseUrl": "https://api.example.com/v1",\n      "apiKey": "key-abcdefgh12345678",\n      "models": [{ "id": "m1" }, { "id": "m2" }]\n    }\n  }\n}')
  const listing = readModels(dir)
  assert.equal(listing.hadComments, true)
  assert.equal(listing.providers.length, 1)
  const p = listing.providers[0]
  assert.equal(p.name, 'my-provider')
  assert.equal(p.modelCount, 2)
  assert.ok(p.apiKeyMasked!.startsWith('•••'))
  assert.equal((p.entry.apiKey as string).includes('abcdefgh1234'), false)
})

test('catalog：默认模型来自 defaultProvider+defaultModel 两个 key，运行目录来自 models-store', () => {
  const dir = makeHome()
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'sub2api-local',
      defaultModel: 'gpt-6.1-terra',
      enabledModels: ['sub2api-local/glm-5.3', 'sub2api-local/deepseek-flash'],
    }),
  )
  writeFileSync(
    join(dir, 'models-store.json'),
    JSON.stringify({ deepseek: { models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }], checkedAt: 1763000000000 } }),
  )
  const catalog = readModelCatalog(dir, readSettings(dir).data)
  assert.deepEqual(catalog.configured, { provider: 'sub2api-local', modelId: 'gpt-6.1-terra' })
  assert.deepEqual(catalog.enabledModels, ['sub2api-local/glm-5.3', 'sub2api-local/deepseek-flash'])
  assert.deepEqual(catalog.modelsJsonProviders, [])
  assert.equal(catalog.store[0].provider, 'deepseek')
  assert.equal(catalog.store[0].modelCount, 2)
  assert.ok(catalog.refs.includes('sub2api-local/gpt-6.1-terra'))
  assert.ok(catalog.refs.includes('sub2api-local/glm-5.3'))
  assert.ok(catalog.refs.includes('deepseek/deepseek-v4-pro'))
})

test('catalog：models-store 损坏时降级为空目录，不影响自建 provider', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'models-store.json'), 'not json')
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { mine: { baseUrl: 'https://x/v1' } } }))
  const catalog = readModelCatalog(dir, {})
  assert.deepEqual(catalog.store, [])
  assert.deepEqual(catalog.modelsJsonProviders, ['mine'])
  assert.equal(catalog.configured.provider, null)
})

test('settings：默认模型两 key 同时写入，清空时同时删除', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', defaultProvider: 'old', defaultModel: 'old-model' }))
  const rev = readSettings(dir).revision
  const first = mutateSettings(dir, rev, (settings) => {
    settings.defaultProvider = 'sub2api-local'
    settings.defaultModel = 'gpt-6.1-terra'
    return true
  })
  assert.equal(first.changed, true)
  const after = readSettings(dir)
  assert.equal(after.data.defaultProvider, 'sub2api-local')
  assert.equal(after.data.defaultModel, 'gpt-6.1-terra')
  assert.equal(after.data.theme, 'dark')
  const cleared = mutateSettings(dir, first.revision, (settings) => {
    delete settings.defaultProvider
    delete settings.defaultModel
    return true
  })
  assert.equal(cleared.changed, true)
  const final = readSettings(dir)
  assert.equal(final.data.defaultProvider, undefined)
  assert.equal(final.data.defaultModel, undefined)
  assert.equal(final.data.theme, 'dark')
})

test('catalog：启用项按 enabledModels 顺序排在前面，模式与不可解析项单独标出', () => {
  const dir = makeHome()
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'gateway',
      defaultModel: 'big',
      enabledModels: ['gateway/big', 'builtin/*', 'gateway/small'],
    }),
  )
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { mine: { baseUrl: 'https://x/v1', models: [{ id: 'a' }] } } }))
  const catalog = readModelCatalog(dir, readSettings(dir).data)
  const refs = catalog.candidates.map((c) => c.ref)
  assert.deepEqual(refs.slice(0, 3), ['gateway/big', 'builtin/*', 'gateway/small'])
  assert.equal(catalog.candidates[0].enabledIndex, 0)
  assert.equal(catalog.candidates[1].pattern, true)
  assert.equal(catalog.candidates[2].resolvable, false)
  const mine = catalog.candidates.find((c) => c.ref === 'mine/a')!
  assert.equal(mine.resolvable, true)
  assert.deepEqual(mine.sources, ['models.json'])
  assert.equal(mine.enabled, false)
  assert.equal(catalog.candidates[0].enabled, true)
})

test('catalog：默认模型与启用项重合时不重复入列', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'p', defaultModel: 'm', enabledModels: ['p/m'] }))
  const catalog = readModelCatalog(dir, readSettings(dir).data)
  const hits = catalog.candidates.filter((c) => c.ref === 'p/m')
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].sources, ['settings.default', 'settings.enabledModels'])
  assert.equal(hits[0].enabled, true)
})

test('auth：写入 api_key 条目，密钥不回传', async () => {
  const dir = makeHome()
  const revision = await mergeAuth(dir, '', {
    zenmux: { type: 'api_key', key: 'sk-secret-9999' },
  })
  assert.ok(revision)
  const listing = readAuth(dir)
  assert.equal(listing.entries.length, 1)
  assert.equal(listing.entries[0].provider, 'zenmux')
  assert.equal(listing.entries[0].type, 'api_key')
  assert.deepEqual(listing.entries[0].maskedFields, ['key'])
  assert.ok((listing.entries[0].entry.key as string).startsWith('•••'))
  const raw = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
  assert.deepEqual(raw.zenmux, { type: 'api_key', key: 'sk-secret-9999' })
})

test('auth：合并写回保留原文，改值写新值，null 删除条目', async () => {
  const dir = makeHome()
  await mergeAuth(dir, '', {
    p1: { type: 'api_key', key: 'sk-keep-1111', env: { REGION: 'eu' } },
    p2: { type: 'oauth', access: 'acc-2222-token', refresh: 'ref-3333-token', expires: 1790000000000 },
  })
  let listing = readAuth(dir)
  const p1 = listing.entries.find((e) => e.provider === 'p1')!
  const p2 = listing.entries.find((e) => e.provider === 'p2')!
  assert.deepEqual(p1.maskedFields.sort(), ['key'])
  assert.deepEqual(p2.maskedFields.sort(), ['access', 'refresh'])
  assert.equal(p2.expires, 1790000000000)

  // 原样提交掩码 + 改 env → key 还原，env 更新
  const submitted1 = JSON.parse(JSON.stringify(p1.entry)) as Record<string, unknown>
  ;(submitted1.env as Record<string, string>).REGION = 'us'
  await mergeAuth(dir, listing.revision, { p1: submitted1 })
  let raw = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
  assert.equal(raw.p1.key, 'sk-keep-1111')
  assert.equal(raw.p1.env.REGION, 'us')

  // oauth 原样提交掩码 + 改 expires → access/refresh 还原
  listing = readAuth(dir)
  const p2entry = listing.entries.find((e) => e.provider === 'p2')!
  const submitted2 = JSON.parse(JSON.stringify(p2entry.entry)) as Record<string, unknown>
  submitted2.expires = 1800000000000
  await mergeAuth(dir, listing.revision, { p2: submitted2 })
  raw = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
  assert.equal(raw.p2.access, 'acc-2222-token')
  assert.equal(raw.p2.refresh, 'ref-3333-token')
  assert.equal(raw.p2.expires, 1800000000000)

  // 改成新 key
  listing = readAuth(dir)
  const p1entry = listing.entries.find((e) => e.provider === 'p1')!.entry
  await mergeAuth(dir, listing.revision, { p1: { ...p1entry, key: 'sk-new-4444' } })
  raw = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
  assert.equal(raw.p1.key, 'sk-new-4444')

  // null 删除
  listing = readAuth(dir)
  await mergeAuth(dir, listing.revision, { p2: null })
  raw = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
  assert.equal(raw.p2, undefined)
  assert.ok(raw.p1)
})

test('auth：revision 不匹配时拒绝写入；!command 形式不遮蔽', async () => {
  const dir = makeHome()
  await mergeAuth(dir, '', { p1: { type: 'api_key', key: 'sk-a-5555' } })
  const listing = readAuth(dir)
  await assert.rejects(mergeAuth(dir, 'stale-revision', { p1: null }), /已被其他进程修改/)
  const withCommand = await mergeAuth(dir, listing.revision, {
    p2: { type: 'api_key', key: '!security find-generic-password -ws p2' },
  })
  assert.ok(withCommand)
  const after = readAuth(dir)
  const p2 = after.entries.find((e) => e.provider === 'p2')!
  assert.equal(p2.keyCommand, '!security find-generic-password -ws p2')
  assert.deepEqual(p2.maskedFields, [])
  assert.equal(p2.entry.key, '!security find-generic-password -ws p2')
})

// ---------------------------------------------------------------------------
// packages 插件条目
// ---------------------------------------------------------------------------

test('plugins：string 条目禁用编码为四空数组 object，enable 还原为 string', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages: ['npm:some-package'] }))
  const disable = applyPackagesMutation(dir, 'disable', 0)
  assert.deepEqual(disable.packages, [{
    source: 'npm:some-package', extensions: [], skills: [], prompts: [], themes: [],
  }])
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages: disable.packages }))
  const enable = applyPackagesMutation(dir, 'enable', 0)
  assert.deepEqual(enable.packages, [{ source: 'npm:some-package' }])
})

test('plugins：带过滤列表的条目禁用被拒绝', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    packages: [{ source: 'npm:pkg', extensions: ['one'], skills: [], prompts: [], themes: [] }],
  }))
  const result = applyPackagesMutation(dir, 'disable', 0)
  assert.ok(result.refusals.length > 0)
})

test('plugins：remove 删除条目', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages: ['a', 'b'] }))
  const result = applyPackagesMutation(dir, 'remove', 0)
  assert.deepEqual(result.packages, ['b'])
})

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

test('agents：profile 解析与渲染往返', async () => {
  const dir = makeHome()
  mkdirSync(join(dir, 'agents'))
  writeFileSync(join(dir, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: 评审\nmodel: claude-sonnet-4-6\n---\n\n你是评审员。')
  const profiles = listAgentProfiles(dir)
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].name, 'reviewer')
  assert.deepEqual(profiles[0].extraKeys, ['model: claude-sonnet-4-6'])
  assert.equal(profiles[0].body.trim(), '你是评审员。')

  const rendered = renderProfile({
    name: 'reviewer',
    description: '评审',
    extraKeys: profiles[0].extraKeys,
    body: profiles[0].body,
  })
  const revision = await saveAgentProfile(dir, 'reviewer.md', undefined, rendered)
  assert.ok(revision)
  assert.equal(readFileSync(join(dir, 'agents', 'reviewer.md'), 'utf8'), rendered)
})

test('agents：settings.json 读写（agents/ 专用文件）', async () => {
  const dir = makeHome()
  mkdirSync(join(dir, 'agents'))
  const before = readAgentsSettings(dir)
  assert.equal(before.builtInEnabled, true)
  assert.equal(before.exists, false)
  const revision = await writeAgentsSettings(dir, '', {
    builtInEnabled: true,
    disabledBuiltIns: ['Explore'],
    maxConcurrent: 5,
  })
  assert.ok(revision)
  const after = readAgentsSettings(dir)
  assert.equal(after.exists, true)
  assert.deepEqual(after.disabledBuiltIns, ['Explore'])
  assert.equal(after.maxConcurrent, 5)
  assert.ok(existsSync(join(dir, 'agents', 'settings.json')))
})

test('mcp 合并写回：原样提交掩码还原原文，改值写新值', async () => {
  const { mergeMcp } = await import('./mcp-file.ts')
  const dir = makeHome()
  await mergeMcp(dir, '', { fs: { command: 'npx', env: { API_KEY: 'sk-clean-8888' } } })
  const l1 = readMcp(dir)
  const masked = l1.servers[0].entry as Record<string, { API_KEY: string }>
  assert.ok(masked.env.API_KEY.startsWith('•••'))
  // 原样提交掩码 + 改 command → key 还原
  const submitted = JSON.parse(JSON.stringify(masked)) as Record<string, unknown>
  submitted.command = 'bunx'
  await mergeMcp(dir, l1.revision, { fs: submitted })
  interface FsEntry { env: { API_KEY: string }; command: string }
  const fileText = readFileSync(join(dir, 'mcp.json'), 'utf8')
  const raw = JSON.parse(fileText) as { mcpServers: Record<string, FsEntry> }
  assert.equal((raw.mcpServers.fs as { env: { API_KEY: string } }).env.API_KEY, 'sk-clean-8888')
  assert.equal(raw.mcpServers.fs.command, 'bunx')
  // 提交新字面量 → 写新值
  const l2 = readMcp(dir)
  const sub2: Record<string, Record<string, unknown>> = { fs: JSON.parse(JSON.stringify(l2.servers[0].entry)) as Record<string, unknown> }
  ;(sub2.fs as { env: { API_KEY: string } }).env.API_KEY = 'brand-new-key'
  await mergeMcp(dir, l2.revision, sub2)
  const raw2 = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, FsEntry> }
  assert.equal((raw2.mcpServers.fs as { env: { API_KEY: string } }).env.API_KEY, 'brand-new-key')
})

test('models 合并写回：原样提交掩码还原原文', async () => {
  const { mergeModels } = await import('./models-auth.ts')
  const dir = makeHome()
  await mergeModels(dir, '', { p1: { baseUrl: 'https://x', apiKey: 'key-abcdef99', models: [{ id: 'm1' }] } })
  const l1 = readModels(dir)
  const entry = JSON.parse(JSON.stringify(l1.providers[0].entry)) as Record<string, unknown>
  assert.ok((entry.apiKey as string).startsWith('•••'))
  entry.baseUrl = 'https://y'
  await mergeModels(dir, l1.revision, { p1: entry })
  const raw = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')) as { providers: { p1: { apiKey: string; baseUrl: string } } }
  assert.equal(raw.providers.p1.apiKey, 'key-abcdef99')
  assert.equal(raw.providers.p1.baseUrl, 'https://y')
})

test('home 解析：~ 展开为当前用户主目录', async () => {
  const { resolveRequestedHome } = await import('./pi-home.ts')
  const { homedir } = await import('node:os')
  // 造一个合法 home 在 ~/ 下
  const base = join(homedir(), '.pi-manager-test-home')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'settings.json'), '{}')
  try {
    const real = await resolveRequestedHome('~/.pi-manager-test-home')
    assert.equal(real, base)
    const single = await resolveRequestedHome('~/.pi-manager-test-home/')
    assert.equal(single, base)
    await assert.rejects(resolveRequestedHome('~nonuser/x'), /绝对路径/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('homes：清单播种默认 home，可新增、改名、移除', async () => {
  const { HomeRegistry, displayLabel } = await import('./homes.ts')
  const { homedir } = await import('node:os')
  const stateFile = join(mkdtempSync(join(tmpdir(), 'pi-registry-')), 'homes.json')
  const dir = mkdtempSync(join(tmpdir(), 'pi-home-a-'))
  writeFileSync(join(dir, 'settings.json'), '{"packages":["a","b"]}')
  mkdirSync(join(dir, 'skills', 'one'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'one', 'SKILL.md'), '---\nname: one\n---\n')
  writeFileSync(join(dir, 'mcp.json'), '{"mcpServers":{"s1":{}}}')
  try {
    const registry = new HomeRegistry(stateFile)
    // 播种：默认 home 在清单里
    const seeded = registry.list()
    assert.ok(seeded.some((h) => h.sources.includes('default') && h.listed))

    // 登记已有目录（adopt）
    const added = await registry.add({ mode: 'adopt', path: dir, name: '我的配置' })
    assert.equal(added.name, '我的配置')
    assert.equal(added.listed, true)
    assert.equal(added.valid, true)
    assert.equal(added.skills, 1)
    assert.equal(added.packages, 2)
    assert.equal(added.mcpServers, 1)
    // 清单落盘
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8')) as Array<{ name: string; path: string }>
    assert.ok(persisted.some((e) => e.name === '我的配置' && e.path === dir))

    // 重复登记拒绝
    await assert.rejects(registry.add({ mode: 'adopt', path: dir }), /已在清单中/)

    // 改名与说明
    const renamed = await registry.update(added.id, { name: '改过的名字', description: '一句话' })
    assert.equal(renamed.name, '改过的名字')
    assert.equal(renamed.description, '一句话')
    await assert.rejects(registry.update(added.id, { name: '  ' }), /name 不能为空/)

    // 移除只动清单
    await registry.remove(added.id)
    assert.equal(registry.list().some((h) => h.path === dir), false)
    assert.ok(existsSync(join(dir, 'settings.json')), '移除不该删文件')

    // 新实例从状态文件恢复
    const reloaded = new HomeRegistry(stateFile)
    assert.equal(reloaded.list().some((h) => h.path === dir), false)

    assert.equal(displayLabel(join(homedir(), '.pi', 'agent')), '~/.pi/agent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('homes：init 初始化默认配置，clone 复制配置但不带凭据', async () => {
  const { HomeRegistry } = await import('./homes.ts')
  const stateFile = join(mkdtempSync(join(tmpdir(), 'pi-registry-')), 'homes.json')
  const registry = new HomeRegistry(stateFile)
  const source = mkdtempSync(join(tmpdir(), 'pi-src-'))
  const targetInit = join(mkdtempSync(join(tmpdir(), 'pi-tgt-')), 'fresh')
  const targetClone = join(mkdtempSync(join(tmpdir(), 'pi-tgt-')), 'cloned')
  try {
    // 来源 home 准备配置
    writeFileSync(join(source, 'settings.json'), '{"defaultThinkingLevel":"high"}')
    writeFileSync(join(source, 'models.json'), '{"providers":{}}')
    writeFileSync(join(source, 'mcp.json'), '{"mcpServers":{}}')
    writeFileSync(join(source, 'auth.json'), '{"p":{"type":"api_key","key":"sk-secret"}}')
    mkdirSync(join(source, 'skills', 's1'), { recursive: true })
    writeFileSync(join(source, 'skills', 's1', 'SKILL.md'), '---\nname: s1\n---\nbody')
    mkdirSync(join(source, 'agents'), { recursive: true })
    writeFileSync(join(source, 'agents', 'a1.md'), '---\nname: a1\n---\n')
    mkdirSync(join(source, 'sessions'), { recursive: true })
    writeFileSync(join(source, 'sessions', 'x.jsonl'), '{}')

    // init：建目录 + 默认骨架
    const created = await registry.add({ mode: 'init', path: targetInit, name: '新配置' })
    assert.equal(created.valid, true)
    assert.equal(created.name, '新配置')
    assert.equal(readFileSync(join(targetInit, 'settings.json'), 'utf8').trim(), '{}')
    assert.ok(existsSync(join(targetInit, 'skills')))
    assert.ok(existsSync(join(targetInit, 'agents')))
    assert.equal(existsSync(join(targetInit, 'auth.json')), false)

    // 非空目录不能初始化
    await assert.rejects(
      registry.add({ mode: 'init', path: targetInit }),
      /目录非空/,
    )
    // 只建最后一级：上级目录缺失时明确报错，不静默生成目录链
    await assert.rejects(
      registry.add({ mode: 'init', path: join(targetInit, 'no-such-parent', 'deep') }),
      /上级目录不存在/,
    )

    // clone：复制配置，跳过 auth.json 与 sessions
    const cloned = await registry.add({ mode: 'clone', path: targetClone, from: source, name: '克隆' })
    assert.equal(cloned.valid, true)
    assert.equal(
      JSON.parse(readFileSync(join(targetClone, 'settings.json'), 'utf8')).defaultThinkingLevel,
      'high',
    )
    assert.ok(existsSync(join(targetClone, 'skills', 's1', 'SKILL.md')))
    assert.ok(existsSync(join(targetClone, 'agents', 'a1.md')))
    assert.equal(existsSync(join(targetClone, 'auth.json')), false, '凭据默认不复制')
    assert.equal(existsSync(join(targetClone, 'sessions')), false, '运行态目录不复制')

    // includeAuth 显式开启才复制凭据
    const targetClone2 = join(mkdtempSync(join(tmpdir(), 'pi-tgt-')), 'withauth')
    await registry.add({ mode: 'clone', path: targetClone2, from: source, includeAuth: true })
    assert.ok(existsSync(join(targetClone2, 'auth.json')))
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// session-task：一次性会话任务的参数校验与任务表
// ---------------------------------------------------------------------------

test('session-task：subagent 定义解析（文件名与 name 都不区分大小写）', async () => {
  const { resolveSubagent } = await import('./session-task.ts')
  const dir = makeHome()
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'agents', 'Reviewer.md'), '---\nname: reviewer\ndescription: 评审\n---\n你是评审员。\n')
  writeFileSync(join(dir, 'agents', 'other.md'), '---\nname: Other-Name\ndescription: 另一个\n---\n正文\n')

  assert.equal(resolveSubagent(dir, 'reviewer').name, 'reviewer')
  assert.equal(resolveSubagent(dir, 'REVIEWER').name, 'reviewer')
  assert.equal(resolveSubagent(dir, 'other').name, 'Other-Name')
  assert.equal(resolveSubagent(dir, 'other-name').name, 'Other-Name')
  assert.throws(() => resolveSubagent(dir, 'nope'), /没有这个 subagent/)
})

test('session-task：参数校验在加载 SDK 之前完成', async () => {
  const { startSessionTask } = await import('./session-task.ts')
  const dir = makeHome()
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'agents', 'a.md'), '---\nname: a\n---\nx\n')

  const base = { home: dir, agent: '测试 agent', subagent: null, instruct: 'hi' }
  await assert.rejects(startSessionTask({ ...base, instruct: '   ' }), /instruct 不能为空/)
  await assert.rejects(
    startSessionTask({ ...base, thinkingLevel: 'ultrathought' }),
    /thinkingLevel 只能是/,
  )
  await assert.rejects(startSessionTask({ ...base, model: 'no-slash' }), /provider\/modelId/)
  await assert.rejects(startSessionTask({ ...base, subagent: 'missing' }), /没有这个 subagent/)
  await assert.rejects(
    startSessionTask({ ...base, cwd: '/definitely/not/a/real/dir' }),
    /cwd 不存在/,
  )
})

test('session-task：任务表按 home 过滤并倒序', async () => {
  const { getTask, listTasks, taskCapacity } = await import('./session-task.ts')
  assert.equal(getTask('missing-id'), null)
  assert.ok(Array.isArray(listTasks()))
  const capacity = taskCapacity()
  assert.ok(capacity.limit >= 1)
  assert.ok(capacity.running >= 0)
})

test('session-task：取消不存在的任务报 404 语义', async () => {
  const { cancelSessionTask } = await import('./session-task.ts')
  await assert.rejects(cancelSessionTask('nope'), /没有这个会话任务/)
})

test('homes：name 唯一，findByName 精确优先再忽略大小写', async () => {
  const { HomeRegistry } = await import('./homes.ts')
  const stateFile = join(mkdtempSync(join(tmpdir(), 'pi-registry-')), 'homes.json')
  const a = mkdtempSync(join(tmpdir(), 'pi-name-a-'))
  const b = mkdtempSync(join(tmpdir(), 'pi-name-b-'))
  writeFileSync(join(a, 'settings.json'), '{}')
  writeFileSync(join(b, 'settings.json'), '{}')
  try {
    const registry = new HomeRegistry(stateFile)
    const first = await registry.add({ mode: 'adopt', path: a, name: 'Writer' })
    // 同名（含大小写差异）拒绝
    await assert.rejects(registry.add({ mode: 'adopt', path: b, name: 'writer' }), /名称已被占用/)
    const second = await registry.add({ mode: 'adopt', path: b, name: 'Reviewer' })

    assert.equal(registry.findByName('Writer')?.id, first.id)
    assert.equal(registry.findByName('reviewer')?.id, second.id, '忽略大小写匹配')
    assert.equal(registry.findByName('缺失'), null)

    // 改名也要查重
    await assert.rejects(registry.update(second.id, { name: 'WRITER' }), /名称已被占用/)
    const renamed = await registry.update(second.id, { name: 'Reviewer-2' })
    assert.equal(renamed.name, 'Reviewer-2')
    // 自己改成同名不算冲突
    const same = await registry.update(second.id, { name: 'Reviewer-2' })
    assert.equal(same.name, 'Reviewer-2')
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('session-task：subagent 的 tools 声明会成为会话工具集', async () => {
  const { parseSubagentTools } = await import('./session-task.ts')
  assert.deepEqual(parseSubagentTools('read, grep, find, ls, bash'), [
    'read', 'grep', 'find', 'ls', 'bash',
  ])
  // 空值 / none 表示不授予工具
  assert.deepEqual(parseSubagentTools(null), [])
  assert.deepEqual(parseSubagentTools(''), [])
  assert.deepEqual(parseSubagentTools('none'), [])
  // 容忍多余空白与尾逗号
  assert.deepEqual(parseSubagentTools(' read , write , '), ['read', 'write'])
})

test('catalog：enabledModels 缺省时 scope=all，全部候选都算启用', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'p', defaultModel: 'm' }))
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { mine: { models: [{ id: 'a' }, { id: 'b' }] } } }))
  const catalog = readModelCatalog(dir, readSettings(dir).data)
  assert.equal(catalog.scope, 'all')
  assert.deepEqual(catalog.enabledModels, [])
  assert.ok(catalog.candidates.length >= 3)
  assert.ok(catalog.candidates.every((c) => c.enabled))
  assert.ok(catalog.candidates.every((c) => c.enabledIndex === null))
})

test('catalog：enabledModels 为空数组时 scope=none，全部候选都不启用', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: [] }))
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { mine: { models: [{ id: 'a' }] } } }))
  const catalog = readModelCatalog(dir, readSettings(dir).data)
  assert.equal(catalog.scope, 'none')
  assert.ok(catalog.candidates.every((c) => !c.enabled))
})

test('catalog：非空清单 scope=explicit，按清单顺序给序号', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: ['b/z', 'a/y'] }))
  const catalog = readModelCatalog(dir, readSettings(dir).data)
  assert.equal(catalog.scope, 'explicit')
  assert.deepEqual(
    catalog.candidates.map((c) => [c.ref, c.enabled, c.enabledIndex]),
    [
      ['b/z', true, 0],
      ['a/y', true, 1],
    ],
  )
})

test('catalog：运行时目录提供 context/maxTokens，并覆盖 models-store 兜底', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: ['sub2api-local/gpt-6.1-terra'] }))
  writeFileSync(
    join(dir, 'models-store.json'),
    JSON.stringify({ openai: { models: [{ id: 'gpt-4' }], checkedAt: 1 } }),
  )
  const runtime = {
    fetchedAt: 1763000000000,
    cwd: '/tmp',
    models: [
      {
        provider: 'sub2api-local',
        id: 'gpt-6.1-terra',
        name: null,
        contextWindow: 500000,
        maxTokens: 128000,
        reasoning: true,
        images: false,
        cost: { input: 0, output: 0 },
      },
    ],
  }
  const catalog = readModelCatalog(dir, readSettings(dir).data, runtime)
  assert.equal(catalog.catalogFetchedAt, 1763000000000)
  assert.equal(catalog.catalogProviders, 1)
  const terra = catalog.candidates.find((c) => c.ref === 'sub2api-local/gpt-6.1-terra')!
  assert.equal(terra.contextWindow, 500000)
  assert.equal(terra.maxTokens, 128000)
  assert.equal(terra.reasoning, true)
  assert.deepEqual(terra.sources, ['runtime', 'settings.enabledModels'])
  assert.ok(catalog.candidates.some((c) => c.ref === 'sub2api-local/gpt-6.1-terra'))
  // 有运行时目录时不再列 models-store 的无鉴权内置模型
  assert.equal(catalog.candidates.some((c) => c.ref === 'openai/gpt-4'), false)
  assert.equal(catalog.candidates.length, 1)
})

test('catalog：没有运行时目录时退回 models-store 候选，context 为未知', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), '{}')
  writeFileSync(
    join(dir, 'models-store.json'),
    JSON.stringify({ openai: { models: [{ id: 'gpt-4' }], checkedAt: 1 } }),
  )
  const catalog = readModelCatalog(dir, readSettings(dir).data)
  assert.equal(catalog.catalogFetchedAt, null)
  const gpt = catalog.candidates.find((c) => c.ref === 'openai/gpt-4')!
  assert.equal(gpt.contextWindow, null)
  assert.deepEqual(gpt.sources, ['models-store.json'])
})

test('catalog：运行时目录的模型 id 大小写不同也能匹配元数据', () => {
  const dir = makeHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: ['sub2api-local/GLM-5.3-Flash'] }))
  const runtime = {
    fetchedAt: 1,
    cwd: '/tmp',
    models: [
      {
        provider: 'sub2api-local',
        id: 'glm-5.3-flash',
        name: 'GLM 5.3 Flash',
        contextWindow: 128000,
        maxTokens: 131072,
        reasoning: true,
        images: false,
        cost: null,
      },
    ],
  }
  const catalog = readModelCatalog(dir, readSettings(dir).data, runtime)
  // 启用项按 settings 里的原始写法保留，元数据来自运行时目录的另一种大小写
  const enabled = catalog.candidates.filter((c) => c.enabled)
  assert.equal(enabled.length, 1)
  assert.equal(enabled[0].ref, 'sub2api-local/GLM-5.3-Flash')
  assert.equal(enabled[0].resolvable, true)
})

test('runtime：缓存缺失或损坏都返回 null', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'pi-manager-state-'))
  const previous = process.env.PI_MANAGER_STATE
  process.env.PI_MANAGER_STATE = join(stateDir, 'homes.json')
  try {
    assert.equal(readCachedCatalog('/tmp/pi-home-x', '/tmp'), null)
    const file = join(stateDir, 'model-catalog')
    mkdirSync(file, { recursive: true })
    const key = createHash('sha256').update('/tmp/pi-home-x\u0000/tmp').digest('hex').slice(0, 16)
    writeFileSync(join(file, `${key}.json`), 'not json')
    assert.equal(readCachedCatalog('/tmp/pi-home-x', '/tmp'), null)
    writeFileSync(join(file, `${key}.json`), JSON.stringify({ fetchedAt: 7, cwd: '/tmp', models: [] }))
    assert.deepEqual(readCachedCatalog('/tmp/pi-home-x', '/tmp'), { fetchedAt: 7, cwd: '/tmp', models: [] })
  } finally {
    if (previous === undefined) delete process.env.PI_MANAGER_STATE
    else process.env.PI_MANAGER_STATE = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})
