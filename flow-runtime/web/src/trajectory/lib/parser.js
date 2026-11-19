const textOf = (content) => {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

const jsonOf = (value) => {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

const timeOf = (row) => {
  const timestamp = Date.parse(row.timestamp ?? '')
  return Number.isFinite(timestamp) ? timestamp : null
}

const blocksOf = (content) => Array.isArray(content) ? content : []

function activeBranch(rows) {
  const byId = new Map(rows.filter((row) => typeof row.id === 'string').map((row) => [row.id, row]))
  const latest = rows.at(-1)
  if (!latest || typeof latest.id !== 'string') return rows

  const selected = new Set()
  let cursor = latest
  while (cursor) {
    if (typeof cursor.id === 'string') selected.add(cursor.id)
    cursor = typeof cursor.parentId === 'string' ? byId.get(cursor.parentId) : undefined
  }
  return rows.filter((row) => row.type === 'session' || (typeof row.id === 'string' && selected.has(row.id)))
}

function newTurn(turn) { return { turn, groups: [] } }

function ensureTurn(turns, current, number) {
  if (current) return current
  const created = newTurn(number)
  turns.push(created)
  return created
}

function cellBase(kind, row, index, text) {
  const time = timeOf(row)
  return {
    index,
    recordId: row.id,
    raw: row,
    kind,
    text: text || '(empty)',
    sourceSeq: index,
    timeSeconds: null,
    startedAt: time,
  }
}

function usageOf(message) {
  const usage = message?.usage
  if (!usage || typeof usage !== 'object') return {}
  return {
    input: Number.isFinite(usage.input) ? usage.input : undefined,
    output: Number.isFinite(usage.output) ? usage.output : undefined,
    cacheRead: Number.isFinite(usage.cacheRead) ? usage.cacheRead : undefined,
    cacheWrite: Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : undefined,
    think: Number.isFinite(usage.reasoning) ? usage.reasoning : undefined,
  }
}

function assistantText(message) {
  return blocksOf(message?.content).filter((block) => block?.type === 'text')
    .map((block) => block.text).join('\n').trim()
}

function assistantThinking(message) {
  return blocksOf(message?.content).filter((block) => block?.type === 'thinking')
    .map((block) => block.thinking).filter(Boolean).join('\n').trim()
}

function buildRows(rows) {
  const turns = []
  const tools = new Map()
  let current = null
  let step = 0
  let index = 0

  const pushGroup = (turn, title, cells) => {
    const group = { title, cells }
    turn.groups.push(group)
    return group
  }

  for (const row of rows) {
    index += 1
    if (row.type === 'message' && row.message?.role === 'user') {
      step = 0
      current = newTurn(turns.length + 1)
      turns.push(current)
      const content = textOf(row.message.content)
      const cell = {
        ...cellBase('user', row, index, content),
        inputDetail: content,
        sourceBlocks: blocksOf(row.message.content).map((block) => ({ type: block.type, content: jsonOf(block) })),
      }
      pushGroup(current, 'User', [cell])
      continue
    }

    if (row.type === 'message' && row.message?.role === 'assistant') {
      current = ensureTurn(turns, current, turns.length + 1)
      step += 1
      const message = row.message
      const output = assistantText(message)
      const thinking = assistantThinking(message)
      const calls = blocksOf(message.content).filter((block) => block?.type === 'toolCall')
      const duration = Number.isFinite(message.durationMs) ? message.durationMs / 1000 : null
      const cell = {
        ...cellBase('message', row, index, output || (thinking ? 'Thinking' : 'Assistant response')),
        ...usageOf(message),
        outputDetail: output,
        thinkingDetail: thinking,
        timeSeconds: duration,
        sourceBlocks: blocksOf(message.content).map((block) => ({
          type: block.type,
          content: block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : jsonOf(block),
          callId: block.id,
          toolName: block.name,
        })),
        assistantMetrics: {
          timingRecorded: false,
          stepStartTime: null,
          firstTokenTime: null,
          completedTime: null,
          usageProvided: Boolean(message.usage),
          outputTokens: Number.isFinite(message.usage?.output) ? message.usage.output : null,
        },
      }
      const group = pushGroup(current, `Step ${step}`, [cell])
      for (const call of calls) {
        const tool = {
          ...cellBase('tool', row, ++index, call.name || 'Tool call'),
          recordId: call.id || `${row.id ?? 'record'}:tool:${index}`,
          raw: { assistant: row, call },
          text: call.name || 'Tool call',
          callId: call.id,
          toolName: call.name,
          inputDetail: jsonOf(call.arguments),
          sourceBlocks: [{ type: 'toolCall', content: jsonOf(call.arguments), callId: call.id, toolName: call.name }],
          timeSeconds: null,
        }
        group.cells.push(tool)
        tools.set(call.id, tool)
      }
      continue
    }

    if (row.type === 'message' && row.message?.role === 'toolResult') {
      const result = row.message
      const tool = tools.get(result.toolCallId)
      const output = textOf(result.content) || jsonOf(result.content)
      if (tool) {
        tool.outputDetail = output
        tool.result = output
        tool.outputBlocks = blocksOf(result.content).map((block) => ({ type: block.type, content: jsonOf(block) }))
        tool.raw = { ...tool.raw, result: row }
        tool.isError = result.isError === true
        const completedAt = timeOf(row)
        tool.timeSeconds = Number.isFinite(result.durationMs)
          ? result.durationMs / 1000
          : Number.isFinite(tool.startedAt) && Number.isFinite(completedAt)
            ? Math.max(0, (completedAt - tool.startedAt) / 1000)
            : null
      } else {
        current = ensureTurn(turns, current, turns.length + 1)
        const cell = {
          ...cellBase('tool', row, index, result.toolName || 'Tool result'),
          raw: { result: row },
          recordId: result.toolCallId || row.id || `tool:${index}`,
          callId: result.toolCallId,
          toolName: result.toolName,
          outputDetail: output,
          result: output,
          isError: result.isError === true,
          outputBlocks: blocksOf(result.content).map((block) => ({ type: block.type, content: jsonOf(block) })),
          timeSeconds: Number.isFinite(result.durationMs) ? result.durationMs / 1000 : null,
        }
        pushGroup(current, `Step ${step || 1}`, [cell])
      }
      continue
    }

    if (row.type === 'compaction' || row.type === 'branch_summary') {
      current = ensureTurn(turns, current, turns.length + 1)
      const summary = textOf(row.summary) || textOf(row.message?.content) || row.type
      pushGroup(current, 'Context', [{
        ...cellBase('compacted', row, index, summary),
        inputDetail: summary,
        outputDetail: summary,
      }])
    }
  }

  return turns
}

export function parsePiJsonl(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) throw new Error('文件为空')
  const rows = lines.map((line, lineIndex) => {
    try { return JSON.parse(line) }
    catch { throw new Error(`第 ${lineIndex + 1} 行不是有效 JSON`) }
  })
  const header = rows.find((row) => row.type === 'session')
  if (!header) throw new Error('不是 Pi Agent session JSONL：缺少 type=session 首行')
  const branch = activeBranch(rows)
  const turns = buildRows(branch)
  const messages = branch.filter((row) => row.type === 'message').length
  return {
    header,
    rows: branch,
    turns,
    stats: {
      lines: rows.length,
      activeLines: branch.length,
      messages,
      turns: turns.length,
      tools: turns.flatMap((turn) => turn.groups.flatMap((group) => group.cells)).filter((cell) => cell.kind === 'tool').length,
    },
  }
}

export function formatTime(value) {
  if (!Number.isFinite(value)) return '—'
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`
  return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
}
