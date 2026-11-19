import React, { useMemo } from 'react'
import { TrajectoryTimeline } from './TrajectoryTimeline.jsx'
import { flattenTurns } from '../lib/trajectory-view.js'
import { deriveTrajectoryTimeline, matchesSearch } from '../lib/timeline.js'

const labels = {
  'kind.system': 'System', 'kind.user': 'User', 'kind.context': 'Context', 'kind.compacted': 'Compacted',
  'kind.assistant': 'Assistant', 'kind.tool': 'Tool', 'kind.subtool': 'Subtool',
  'column.input': 'Input', 'column.model': 'Model', 'column.tools': 'Tools',
  'timeline.aria': 'Timeline overview', 'timeline.noTimingData': 'No timing data',
  'timeline.overviewAria': 'Timeline: drag to select, wheel to zoom, right-drag to pan. Escape clears selection. Home resets zoom.',
}
const translate = (key, values = {}) => key === 'timeline.total' ? `Total ${values.duration}` : key === 'timeline.started' ? `Started ${values.time}` : key === 'timeline.ttftDecoding' ? `TTFT ${values.ttft} · Decoding ${values.decoding}` : labels[key] || key

export function Timeline({ turns, selectedId, onSelect, actualDuration, query = '', range = null, onRangeChange = () => {}, onRecordFocus }) {
  const records = useMemo(() => flattenTurns(turns), [turns])
  const selectedIndex = records.find(record => record.cell.recordId === selectedId)?.position ?? null
  const searchMatchIndexes = useMemo(() => query.trim() ? new Set(records.filter(({ cell, turn }) => matchesSearch(cell, query, turn)).map(record => record.position)) : null, [records, query])
  const durationFallback = useMemo(() => actualDuration && deriveTrajectoryTimeline(turns, 'duration')?.durationFallback, [turns, actualDuration])
  return <>{durationFallback && <div className="timeline-mode-note" role="status">No elapsed duration · showing record order</div>}<TrajectoryTimeline key={String(actualDuration)} t={translate} turns={turns} mode={actualDuration && !durationFallback ? 'duration' : 'sequence'} range={range} onRangeChange={onRangeChange} selectedIndex={selectedIndex} searchMatchIndexes={searchMatchIndexes} onRecordSelect={index => onSelect?.(records.find(record => record.position === index)?.cell)} onRecordFocus={onRecordFocus} /></>
}
