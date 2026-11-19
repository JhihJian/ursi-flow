import React, { useMemo, useState } from 'react'
import { TrajectoryToolbar } from './TrajectoryToolbar.jsx'
import { Timeline } from './Timeline.jsx'
import { TrajectoryTable } from './TrajectoryTable.jsx'
import { allFolded, flattenTurns, foldTargets, toggleAllFolds, toggleCallGroups, toggleFold } from '../lib/trajectory-view.js'
import { matchesSearch, trajectoryTimelineFocusIndexes } from '../lib/timeline.js'
import viewsCss from './reference/views.module.css'
import styles from './styles/viewer.module.css'
import './styles/index.css'

const readStoredDuration = () => {
  try { return localStorage.getItem('pi-trajectory-duration') === 'true' } catch { return false }
}
const storeDuration = value => {
  try { localStorage.setItem('pi-trajectory-duration', String(value)) } catch { /* Storage may be disabled. */ }
}

export function TrajectoryViewer({ turns, sessionRevision = 0, defaultDuration, defaultQuery = '', onSelectionChange, className = '' }) {
  const [selected, setSelected] = useState(null)
  const [query, setQuery] = useState(defaultQuery)
  const [actualDuration, setActualDuration] = useState(defaultDuration ?? readStoredDuration)
  const [collapsedTurns, setCollapsedTurns] = useState(new Set())
  const [collapsedAssistants, setCollapsedAssistants] = useState(new Set())
  const [range, setRange] = useState(null)
  const [focusRequest, setFocusRequest] = useState(null)
  const records = useMemo(() => flattenTurns(turns), [turns])
  const targets = useMemo(() => foldTargets(records), [records])
  const focusIndexes = useMemo(() => trajectoryTimelineFocusIndexes(turns, range, actualDuration ? 'duration' : 'sequence'), [turns, range, actualDuration])

  const changeSelection = cell => {
    const record = records.find(record => record.cell === cell)
    if (record) {
      setCollapsedTurns(current => { const next = new Set(current); next.delete(record.turn); return next })
      setCollapsedAssistants(current => { const next = new Set(current); next.delete(record.assistantId); return next })
      if (!matchesSearch(cell, query, record.turn)) setQuery('')
      if (focusIndexes && !focusIndexes.has(record.position)) setRange(null)
      setFocusRequest({ index: record.position })
    } else if (!cell && selected) {
      const previous = records.find(record => record.cell === selected)
      if (previous) setFocusRequest({ index: previous.position, focus: true })
    }
    setSelected(cell?.recordId ? cell : null)
    onSelectionChange?.(cell?.recordId ? cell : null)
  }
  const clearRange = () => { setRange(null); setFocusRequest(null) }
  const changeRange = next => {
    setRange(next)
    if (next && window.matchMedia('(max-width: 760px)').matches) setSelected(null)
    const indexes = trajectoryTimelineFocusIndexes(turns, next, actualDuration ? 'duration' : 'sequence')
    const record = records.find(record => indexes?.has(record.position) && matchesSearch(record.cell, query, record.turn))
    setFocusRequest(record ? { index: record.position, focus: true } : null)
  }
  const changeDuration = value => {
    setActualDuration(value)
    clearRange()
    storeDuration(value)
  }
  const toggleAssistants = () => {
    clearRange()
    const next = toggleCallGroups(collapsedAssistants, targets.assistants)
    setCollapsedTurns(next.collapsedTurns)
    setCollapsedAssistants(next.collapsedAssistants)
  }
  return <div className={`${viewsCss.root} ${styles.root} trajectory-shell ${className}`}>
    <TrajectoryToolbar query={query} setQuery={setQuery} actualDuration={actualDuration} setActualDuration={changeDuration} allTurnsCollapsed={allFolded(targets.turns, collapsedTurns)} onToggleTurns={() => { clearRange(); setCollapsedTurns(current => toggleAllFolds(current, targets.turns)) }} allAssistantsCollapsed={allFolded(targets.assistants, collapsedAssistants)} onToggleAssistants={toggleAssistants} />
    <Timeline key={sessionRevision} turns={turns} selectedId={selected?.recordId} onSelect={changeSelection} actualDuration={actualDuration} query={query} range={range} onRangeChange={changeRange} onRecordFocus={index => setFocusRequest({ index, focus: true })} />
    <div className={`${viewsCss.ledger} trajectory-ledger`}><TrajectoryTable turns={turns} selectedId={selected?.recordId} onSelect={changeSelection} collapsedAssistants={collapsedAssistants} onToggleAssistant={id => { clearRange(); setCollapsedAssistants(current => toggleFold(current, id)) }} collapsedTurns={collapsedTurns} onToggleTurn={turn => { clearRange(); setCollapsedTurns(current => toggleFold(current, turn)) }} query={query} focusIndexes={focusIndexes} focusRequest={focusRequest} onClearRange={clearRange} /></div>
  </div>
}
