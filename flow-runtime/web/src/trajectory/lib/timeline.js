// Pi data adapter for DeepSeek's timeline interaction model (f3803c9697).
import { flattenTurns, projectTimeline } from './trajectory-view.js'

export function deriveTrajectoryTimeline(turns, mode = 'sequence') {
  const spans = projectTimeline(flattenTurns(turns), mode !== 'sequence').map(({ cell, position, turn, start, end }) => ({
    start, end, turn, index: position, recordId: cell.recordId,
    isError: cell.isError === true, kind: cell.kind, label: cell.text,
    lane: cell.kind === 'tool' ? 2 : ['message', 'compacted'].includes(cell.kind) ? 1 : 0,
  }))
  if (!spans.length) return null
  const boundaries = new Map()
  let start = Infinity
  let end = -Infinity
  for (const span of spans) {
    start = Math.min(start, span.start)
    end = Math.max(end, span.end)
    boundaries.set(span.turn, Math.min(boundaries.get(span.turn) ?? Infinity, span.start))
  }
  if (mode !== 'sequence' && end <= start) return { ...deriveTrajectoryTimeline(turns, 'sequence'), durationFallback: true }
  return { start, end, spans, turnBoundaries: [...boundaries].map(([turn, time]) => ({ turn, time })) }
}

export function trajectoryTimelineFocusIndexes(turns, range, mode = 'sequence') {
  if (range === null) return null
  const start = Math.min(range.start, range.end)
  const end = Math.max(range.start, range.end)
  return new Set(deriveTrajectoryTimeline(turns, mode)?.spans.filter(span => span.start <= end && span.end >= start).map(span => span.index))
}

export const formatTimelineOffset = milliseconds => `${Math.round(milliseconds).toLocaleString()} ms`

export function matchesSearch(cell, query = '', turn) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const text = [turn == null ? '' : `turn ${turn}`, cell.kind, cell.kind === 'message' ? 'assistant' : '', cell.recordId, cell.callId, cell.toolName, cell.text, cell.inputDetail, cell.outputDetail, cell.thinkingDetail, cell.result].filter(value => value != null).join(' ').toLocaleLowerCase()
  return terms.every(term => text.includes(term))
}
