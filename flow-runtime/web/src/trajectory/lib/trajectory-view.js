// Projection and folding adapt the DeepSeek trajectory behavior to Pi records.
export function flattenTurns(turns) {
  let position = 0
  return turns.flatMap((turn) => turn.groups.flatMap((group, groupIndex) => {
    const assistant = group.cells.find((cell) => cell.kind === 'message')
    const assistantId = assistant ? assistant.recordId || `${turn.turn}:${groupIndex}` : null
    return group.cells.map((cell, cellIndex) => ({
      cell,
      position: ++position,
      turn: turn.turn,
      assistantId,
      turnStart: groupIndex === 0 && cellIndex === 0,
      groupStart: cellIndex === 0,
      turnEnd: groupIndex === turn.groups.length - 1 && cellIndex === group.cells.length - 1,
    }))
  }))
}

export function foldTargets(records) {
  const turnCounts = new Map()
  const assistants = new Set()
  for (const record of records) {
    turnCounts.set(record.turn, (turnCounts.get(record.turn) || 0) + 1)
    if (record.cell.kind === 'tool' && record.assistantId !== null) assistants.add(record.assistantId)
  }
  return { turns: [...turnCounts].filter(([, count]) => count > 1).map(([turn]) => turn), assistants: [...assistants] }
}

export function allFolded(ids, collapsed) {
  return ids.length > 0 && ids.every((id) => collapsed.has(id))
}

export function toggleFold(current, id) {
  const next = new Set(current)
  next.has(id) ? next.delete(id) : next.add(id)
  return next
}

export function toggleAllFolds(current, ids) {
  const next = new Set(current)
  const expand = allFolded(ids, current)
  for (const id of ids) expand ? next.delete(id) : next.add(id)
  return next
}

// Calls acts on a nested level, so reveal its parent turns with the same update.
export function toggleCallGroups(collapsedAssistants, assistantIds) {
  return {
    collapsedTurns: new Set(),
    collapsedAssistants: toggleAllFolds(collapsedAssistants, assistantIds),
  }
}

const countLabel = (count, name) => `${count} ${name}${count === 1 ? '' : 's'}`

export function foldRecords(records, collapsedTurns, collapsedAssistants) {
  const byTurn = new Map()
  for (const record of records) {
    if (!byTurn.has(record.turn)) byTurn.set(record.turn, [])
    byTurn.get(record.turn).push(record)
  }
  return [...byTurn.values()].flatMap((turnRecords) => {
    const first = turnRecords[0]
    if (collapsedTurns.has(first.turn) && turnRecords.length > 1) {
      const rest = turnRecords.slice(1)
      const steps = rest.filter(({ cell }) => cell.kind === 'message').length
      const calls = rest.filter(({ cell }) => cell.kind === 'tool').length
      return [{ ...first, turnEnd: false }, {
        ...first, turnStart: false, groupStart: false, turnEnd: true,
        summaryKind: 'turn', summary: `${countLabel(steps, 'step')} · ${countLabel(calls, 'tool call')}`,
      }]
    }
    const visible = []
    for (let index = 0; index < turnRecords.length; index += 1) {
      const record = turnRecords[index]
      visible.push(record)
      if (record.cell.kind !== 'message' || !collapsedAssistants.has(record.assistantId)) continue
      const calls = []
      while (turnRecords[index + 1]?.cell.kind === 'tool' && turnRecords[index + 1].assistantId === record.assistantId) {
        calls.push(turnRecords[++index])
      }
      if (!calls.length) continue
      const names = [...new Set(calls.map(({ cell }) => cell.toolName || cell.text))].join(', ')
      visible[visible.length - 1] = { ...record, turnEnd: false }
      visible.push({
        ...record, turnStart: false, groupStart: false, turnEnd: calls.at(-1).turnEnd,
        summaryKind: 'assistant', summary: `${countLabel(calls.length, 'tool call')}${names ? ` · ${names}` : ''}`,
      })
    }
    return visible
  })
}

export function projectTimeline(records, actualDuration) {
  if (!actualDuration) return records.map((record, index) => ({ ...record, start: index, end: index + 1 }))
  const spans = records.filter(({ cell }) => Number.isFinite(cell.startedAt)).map((record) => ({
    ...record,
    start: record.cell.startedAt,
    end: record.cell.startedAt + (Number.isFinite(record.cell.timeSeconds) ? Math.max(0, record.cell.timeSeconds * 1000) : 0),
  }))
  let removedIdle = 0
  let coveredUntil = null
  const offsets = new Map()
  for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (coveredUntil !== null && span.start > coveredUntil) removedIdle += span.start - coveredUntil
    offsets.set(span, removedIdle)
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end)
  }
  return spans.map((span) => ({ ...span, start: span.start - offsets.get(span), end: span.end - offsets.get(span) }))
}
