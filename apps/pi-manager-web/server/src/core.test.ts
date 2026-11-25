import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJsonc, stripJsonComments } from './jsonc.ts'
import { readSnapshotSync, writeSnapshot, ConflictError } from './rw.ts'
import { readSettings, mutateSettings } from './settings-file.ts'
import { toggleDisableModelInvocation, readDisableModelInvocation } from './skills.ts'
import { readMcp, maskSecret } from './mcp-file.ts'
import { readModels, readAuth, setAuthApiKey } from './models-auth.ts'
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

test('auth：设置与读取，密钥不回传', async () => {
  const dir = makeHome()
  const revision = await setAuthApiKey(dir, '', 'zenmux', 'sk-secret-9999')
  assert.ok(revision)
  const listing = readAuth(dir)
  assert.equal(listing.entries.length, 1)
  assert.equal(listing.entries[0].provider, 'zenmux')
  assert.equal(listing.entries[0].type, 'api_key')
  assert.ok(listing.entries[0].masked!.startsWith('•••'))
  const raw = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
  assert.equal(raw.zenmux.api_key, 'sk-secret-9999')
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
