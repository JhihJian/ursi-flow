import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { replay, SKILL_BLOCK_PATTERN } from './replay.ts'

const line = (row: unknown) => `${JSON.stringify(row)}\n`

const header = (id = 'sess-1') =>
  line({ type: 'session', version: 3, id, timestamp: '2026-01-05T10:00:00.000Z', cwd: '/demo/alpha' })

/** 工具声明里只有 name 被用到，其余字段模拟真实条目里那些大字段。 */
const tool = (name: string) => ({ name, description: `${name} 的说明`, parameters: { type: 'object', properties: {} } })

const systemEntry = (id: string, parentId: string | null, message: Record<string, unknown>) =>
  line({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-05T10:00:01.000Z',
    message: { role: 'system', content: '', timestamp: 0, ...message },
  })

const userEntry = (id: string, parentId: string | null, text: string) =>
  line({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-05T10:00:02.000Z',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1767607202000 },
  })

const assistantEntry = (
  id: string,
  parentId: string | null,
  provider = 'anthropic',
  model = 'claude-sonnet-4',
  thinkingLevel?: string,
) =>
  line({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-05T10:00:03.000Z',
    message: {
      role: 'assistant',
      provider,
      model,
      content: [{ type: 'text', text: '好' }],
      usage: {},
      stopReason: 'endTurn',
      timestamp: 1767607203000,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
  })

/** formatSkillsForPrompt 的实际产出形态：分区里再套一层 <skills> 与 <available_skills>。 */
const skillsSection = (skills: { name: string; location: string }[]) =>
  [
    '<skills>',
    '',
    'The following skills provide specialized instructions for specific tasks.',
    '',
    '<available_skills>',
    ...skills.flatMap((skill) => [
      '  <skill>',
      `    <name>${skill.name}</name>`,
      '    <description>某个 skill 的说明</description>',
      `    <location>${skill.location}</location>`,
      '  </skill>',
    ]),
    '</available_skills>',
    '',
    '</skills>',
  ].join('\n')

const CODEINDEX = { name: 'codeindex', location: '/home/dev/.pi/agent/skills/codeindex/SKILL.md' }

test('基本会话：leading system 声明 skills 与工具，模型来自 assistant', () => {
  const jsonl = [
    header(),
    systemEntry('m1', null, {
      sections: {
        preamble: '你是编码助手。',
        tools: '<tools>\n- read: 读文件\n</tools>',
        skills: skillsSection([CODEINDEX]),
        cwd: '<cwd>\n/demo/alpha\n</cwd>',
      },
      toolsAdded: [tool('read'), tool('bash')],
    }),
    userEntry('m2', 'm1', '帮我看看这个仓库'),
    assistantEntry('m3', 'm2'),
  ].join('')

  const facts = replay(jsonl)

  assert.equal(facts.source, 'file')
  assert.equal(facts.recorded, true)
  assert.equal(facts.reason, undefined)
  assert.deepEqual(facts.model.initial, { provider: 'anthropic', model: 'claude-sonnet-4' })
  assert.deepEqual(facts.model.current, { provider: 'anthropic', model: 'claude-sonnet-4' })
  assert.deepEqual(facts.model.changes, [])
  assert.deepEqual(facts.skills.listed, [CODEINDEX])
  assert.deepEqual(facts.skills.read, [])
  assert.deepEqual(facts.tools.names, ['read', 'bash'])
  assert.deepEqual(facts.promptSectionKeys, ['preamble', 'tools', 'skills', 'cwd'])
})

test('model_change 切换后 current 更新并留下切换记录', () => {
  const jsonl = [
    header(),
    systemEntry('m1', null, { sections: { preamble: '你是编码助手。' }, toolsAdded: [tool('read')] }),
    userEntry('m2', 'm1', '提问'),
    assistantEntry('m3', 'm2'),
    line({
      type: 'model_change',
      id: 'm4',
      parentId: 'm3',
      timestamp: '2026-01-05T10:01:00.000Z',
      provider: 'openai',
      modelId: 'gpt-5',
    }),
    assistantEntry('m5', 'm4', 'openai', 'gpt-5'),
  ].join('')

  const facts = replay(jsonl)

  assert.deepEqual(facts.model.initial, { provider: 'anthropic', model: 'claude-sonnet-4' })
  assert.deepEqual(facts.model.current, { provider: 'openai', model: 'gpt-5' })
  assert.equal(facts.model.changes.length, 1)
  assert.deepEqual(facts.model.changes[0], {
    provider: 'openai',
    model: 'gpt-5',
    at: Date.parse('2026-01-05T10:01:00.000Z'),
  })
})

test('没有 system 消息的老会话：记不到提示词事实，模型仍从 assistant 得出', () => {
  const jsonl = [
    line({
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: '2026-01-04T09:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '老会话提问' }] },
    }),
    line({
      type: 'message',
      id: 'm2',
      parentId: 'm1',
      timestamp: '2026-01-04T09:00:30.000Z',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4',
        content: [{ type: 'text', text: '老会话回答' }],
        timestamp: 1767517230000,
      },
    }),
  ].join('')

  const facts = replay(jsonl)

  assert.equal(facts.recorded, false)
  assert.equal(facts.reason, 'not_recorded')
  assert.deepEqual(facts.model.current, { provider: 'anthropic', model: 'claude-haiku-4' })
  assert.equal(facts.skills.listed, null)
  assert.equal(facts.skills.read, null)
  assert.equal(facts.mcp.servers, null)
  assert.equal(facts.mcp.note, null)
  assert.equal(facts.tools.names, null)
  assert.equal(facts.promptSectionKeys, null)
})

test('compaction 的 systemMessage 快照整体替换提示词状态', () => {
  const jsonl = [
    header(),
    systemEntry('m1', null, {
      sections: { preamble: '你是编码助手。', skills: skillsSection([CODEINDEX]) },
      toolsAdded: [tool('read'), tool('bash')],
    }),
    userEntry('m2', 'm1', '压缩前的提问'),
    assistantEntry('m3', 'm2'),
    line({
      type: 'compaction',
      id: 'm4',
      parentId: 'm3',
      timestamp: '2026-01-05T10:10:00.000Z',
      summary: '之前的对话摘要',
      firstKeptEntryId: 'm3',
      tokensBefore: 120000,
      systemMessage: {
        role: 'system',
        content: '',
        sections: { preamble: '你是编码助手。', cwd: '<cwd>\n/demo/alpha\n</cwd>' },
        toolsAdded: [tool('read')],
        timestamp: 1767607800000,
      },
    }),
    userEntry('m5', 'm4', '压缩后的提问'),
    assistantEntry('m6', 'm5'),
  ].join('')

  const facts = replay(jsonl)

  assert.equal(facts.recorded, true)
  assert.deepEqual(facts.skills.listed, [])
  assert.deepEqual(facts.tools.names, ['read'])
  assert.deepEqual(facts.promptSectionKeys, ['preamble', 'cwd'])
})

test('用户消息里的 skill 展开块进入 skills.read', () => {
  const expanded = [
    '<skill name="codeindex" location="/home/dev/.pi/agent/skills/codeindex/SKILL.md">',
    '# CodeIndex',
    '用索引定位符号。',
    '</skill>',
    '',
    '帮我用 codeindex 找一下 replay 函数',
  ].join('\n')

  const jsonl = [
    header(),
    systemEntry('m1', null, { sections: { preamble: '你是编码助手。' }, toolsAdded: [tool('read')] }),
    userEntry('m2', 'm1', '需要索引一下'),
    assistantEntry('m3', 'm2'),
    userEntry('m4', 'm3', expanded),
    assistantEntry('m5', 'm4'),
  ].join('')

  const facts = replay(jsonl)

  assert.ok(SKILL_BLOCK_PATTERN.test(expanded))
  assert.deepEqual(facts.skills.read, [{ name: 'codeindex', location: '/home/dev/.pi/agent/skills/codeindex/SKILL.md' }])
})

test('坏行跳过不抛错', () => {
  const jsonl = [
    header(),
    '{"type":"message","id":"m1",\n',
    '这行根本不是 JSON\n',
    systemEntry('m1', null, { sections: { preamble: '你是编码助手。' }, toolsAdded: [tool('read')] }),
    '[1,2,3]\n',
    userEntry('m2', 'm1', '提问'),
    assistantEntry('m3', 'm2'),
  ].join('')

  const facts = replay(jsonl)

  assert.equal(facts.recorded, true)
  assert.deepEqual(facts.tools.names, ['read'])
  assert.deepEqual(facts.model.current, { provider: 'anthropic', model: 'claude-sonnet-4' })
})

test('mcp_servers 分区与工具名前缀合并去重', () => {
  const jsonl = [
    header(),
    systemEntry('m1', null, {
      sections: {
        preamble: '你是编码助手。',
        mcp_servers: [
          '<mcp_servers>',
          'MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts.',
          '- mcp__alpha (codemode): 代码索引',
          '- mcp__beta_ops (tool_search)',
          '- … 1 more server; find their tools with searchTools()',
          '</mcp_servers>',
        ].join('\n'),
      },
      toolsAdded: [tool('read'), tool('mcp__alpha__search'), tool('mcp__beta_ops__list')],
    }),
    userEntry('m2', 'm1', '提问'),
    assistantEntry('m3', 'm2'),
  ].join('')

  const facts = replay(jsonl)

  assert.deepEqual(facts.mcp.servers, ['alpha', 'beta_ops'])
  assert.equal(facts.mcp.note, '尽力推断：不含连接失败或未暴露工具的 server')
})

test('分支被分叉时只重放最后一条所在的分支', () => {
  const jsonl = [
    header(),
    systemEntry('m1', null, { sections: { preamble: '你是编码助手。' }, toolsAdded: [tool('read')] }),
    userEntry('m2', 'm1', '提问'),
    // 分叉 A：被后来的分叉 B 取代，不在当前分支上。
    assistantEntry('m3', 'm2', 'anthropic', 'claude-sonnet-4'),
    // 分叉 B：最后一条所在的分支。
    assistantEntry('m4', 'm2', 'openai', 'gpt-5'),
  ].join('')

  const facts = replay(jsonl)

  assert.deepEqual(facts.model.initial, { provider: 'openai', model: 'gpt-5' })
  assert.deepEqual(facts.model.current, { provider: 'openai', model: 'gpt-5' })
  assert.deepEqual(facts.model.changes, [])
})

test('facts/ 的源码不依赖 config 域，也不做 IO', () => {
  const forbidden = ["from '../config", 'node:fs', 'node:path', 'node:net', 'node:http', 'node:child_process']
  // 这个测试文件自己要用 node:fs 读源码，所以只查非测试文件。
  const sources = readdirSync(import.meta.dirname).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))

  assert.ok(sources.length > 0)
  for (const name of sources) {
    const text = readFileSync(join(import.meta.dirname, name), 'utf-8')
    for (const pattern of forbidden) {
      assert.equal(text.includes(pattern), false, `${name} 不应出现 ${pattern}`)
    }
  }
})
