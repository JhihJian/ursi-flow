import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Detail } from './Detail.jsx'
import { flattenTurns, foldRecords, foldTargets } from '../lib/trajectory-view.js'
import { matchesSearch } from '../lib/timeline.js'
import tableCss from './reference/TrajectoryTable.module.css'

const kindLabel = { user: 'User', message: 'Assistant', tool: 'Tool', compacted: 'Compacted' }
const kindClass = { user: tableCss.user, message: tableCss.assistantVioletBright, tool: tableCss.toolAmber, compacted: tableCss.compacted }
const oneLine = (value, limit = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
function toolTarget(cell) {
  const args = cell.raw?.call?.arguments
  if (typeof args === 'string') return oneLine(args)
  if (!args || typeof args !== 'object') return ''
  const key = ['command', 'cmd', 'path', 'filePath', 'pattern', 'query', 'url', 'script'].find(key => typeof args[key] === 'string' && args[key].trim())
  return oneLine(key ? args[key] : Object.values(args).find(value => typeof value === 'string' && value.trim()) || JSON.stringify(args))
}

function Cell({ record, selected, onSelect, onToggle, query, activeTurn, focusIndexes, rowRef, virtualIndex }) {
  const { cell, turnStart, turnEnd, groupStart } = record
  const label = kindLabel[cell.kind] || cell.kind
  return <tr ref={rowRef} data-index={virtualIndex} tabIndex="0" aria-label={`${label}: ${cell.text}`} aria-selected={selected || undefined} data-kind={cell.kind} data-record-id={cell.recordId} data-record-index={cell.index} data-position={record.position} data-group-start={groupStart || undefined} data-turn-start={turnStart || undefined} data-turn-end={turnEnd || undefined} data-search-match={matchesSearch(cell, query, record.turn) ? 'true' : 'false'} data-timeline-focus={focusIndexes === null ? undefined : focusIndexes.has(record.position) ? 'true' : 'false'} data-selected={selected ? 'true' : undefined} data-error={cell.isError ? 'true' : undefined} onClick={() => onSelect(cell)} onDoubleClick={onToggle} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(cell) } }}>
    <td className={tableCss.event}>
      {turnStart && <span className={record.turn === activeTurn ? `${tableCss.turnLabel} ${tableCss.turnLabelActive}` : tableCss.turnLabel} aria-label={`Turn ${record.turn}`}><span className={tableCss.turnLabelFull}>Turn {record.turn}</span><span className={tableCss.turnLabelCompact}>T{record.turn}</span></span>}
      {record.turn === activeTurn && <span className={tableCss.turnRail} aria-hidden="true" />}
      {selected && <span className={tableCss.selectionRail} aria-hidden="true" />}
      <div className={tableCss.eventInner}><span className={tableCss.kindSlot}><span className={`${tableCss.kindTag} ${kindClass[cell.kind]}`} data-role-kind={cell.kind}><span className={tableCss.kindTagIcon} aria-hidden="true">{label[0]}</span><span className={tableCss.kindTagLabel}>{label}</span></span></span></div>
    </td>
    <td className={tableCss.content}>{cell.kind === 'tool' ? <span className="tool-call-summary" title={toolTarget(cell) || cell.text}><span className="tool-call-summary-title">{toolTarget(cell) || cell.text}</span><span className={cell.isError ? 'tool-call-summary-status tool-call-summary-error' : 'tool-call-summary-status'}>{cell.isError ? 'Error' : cell.raw?.result ? (cell.result ? oneLine(cell.result) : 'Empty result') : 'No result recorded'}</span></span> : cell.result ? <span className={`${tableCss.resultPreview} tool-result-preview`}><span className={tableCss.resultRequest}><span className={tableCss.contentText} title={cell.text}>{cell.text}</span></span><span className={cell.isError ? `${tableCss.inlineResult} ${tableCss.error}` : tableCss.inlineResult}><span className={tableCss.arrow}>→</span><span className={tableCss.inlineResultText}>{oneLine(cell.result)}</span></span></span> : <span className={tableCss.contentText} title={cell.text}>{cell.text}</span>}</td>
  </tr>
}

export function TrajectoryTable({ turns, selectedId, onSelect, collapsedAssistants = new Set(), collapsedTurns = new Set(), query = '', onToggleTurn, onToggleAssistant, focusIndexes = null, focusRequest = null, onClearRange }) {
  const records = useMemo(() => flattenTurns(turns), [turns])
  const listRef = useRef(null)
  const splitRef = useRef(null)
  const resize = useRef(null)
  const focusedRequest = useRef(null)
  const [detailsWidth, setDetailsWidth] = useState(480)
  const searching = Boolean(query.trim())
  const displayRecords = useMemo(() => searching ? records.filter(({ cell, turn }) => matchesSearch(cell, query, turn)) : records, [records, searching, query])
  const selectedRecord = records.find(record => record.cell.recordId === selectedId)
  const selected = selectedRecord && (!searching || matchesSearch(selectedRecord.cell, query, selectedRecord.turn)) ? selectedRecord.cell : null
  const visibleRecords = useMemo(() => {
    if (searching) return displayRecords
    const turns = new Set(collapsedTurns)
    const assistants = new Set(collapsedAssistants)
    for (const record of records) if (focusIndexes?.has(record.position) || record.position === focusRequest?.index) {
      turns.delete(record.turn)
      assistants.delete(record.assistantId)
    }
    return foldRecords(records, turns, assistants)
  }, [records, displayRecords, searching, collapsedTurns, collapsedAssistants, focusIndexes, focusRequest])
  const targets = useMemo(() => foldTargets(records), [records])
  const virtual = visibleRecords.length > 100
  const virtualizer = useVirtualizer({ count: visibleRecords.length, getScrollElement: () => listRef.current, estimateSize: () => 40, overscan: 8, enabled: virtual, getItemKey: index => `${visibleRecords[index].position}-${visibleRecords[index].summaryKind || 'record'}` })
  const items = virtual ? virtualizer.getVirtualItems() : visibleRecords.map((_, index) => ({ index, key: index }))
  const requestedPosition = focusRequest?.index ?? selectedRecord?.position
  const targetPosition = visibleRecords.some(record => !record.summaryKind && record.position === requestedPosition) ? requestedPosition : visibleRecords.find(record => focusIndexes?.has(record.position))?.position
  useEffect(() => {
    const index = visibleRecords.findIndex(record => !record.summaryKind && record.position === targetPosition)
    if (index < 0) return
    if (virtual) virtualizer.scrollToIndex(index, { align: 'center' })
    const frame = requestAnimationFrame(() => {
      const row = listRef.current?.querySelector(`[data-position="${targetPosition}"]`)
      row?.scrollIntoView({ block: 'nearest' })
      if (row && focusRequest?.focus && focusedRequest.current !== focusRequest) {
        row.focus({ preventScroll: true })
        focusedRequest.current = focusRequest
      }
      if (row && listRef.current && row.getBoundingClientRect().top < listRef.current.getBoundingClientRect().top + 36) listRef.current.scrollTop -= 36
    })
    return () => cancelAnimationFrame(frame)
  }, [targetPosition, focusRequest, visibleRecords, virtual, virtualizer])
  const toggleRecord = record => {
    if (record.summaryKind === 'turn' || collapsedTurns.has(record.turn)) onToggleTurn?.(record.turn)
    else if (record.assistantId && targets.assistants.includes(record.assistantId) && record.cell.kind === 'message') onToggleAssistant?.(record.assistantId)
    else if (record.turnStart && targets.turns.includes(record.turn)) onToggleTurn?.(record.turn)
  }
  const boundedWidth = value => Math.max(320, Math.min(720, (splitRef.current?.clientWidth ?? 960) - 240, value))
  const rangeCount = focusIndexes === null ? null : displayRecords.filter(record => focusIndexes.has(record.position)).length
  return <div ref={splitRef} className={`${tableCss.split} viewer-split`} data-details-open={Boolean(selected)} style={{ '--details-width': `${detailsWidth}px` }}>
    <div ref={listRef} className={`${tableCss.tablePane} record-list`} onKeyDown={event => { if (event.key === 'Escape' && focusIndexes !== null) { event.preventDefault(); onClearRange?.() } }}>
      <div className="ledger-heading"><span>Session records</span><span role="status">{displayRecords.length} {searching ? 'matches' : 'records'}{rangeCount !== null && <> · {rangeCount} in range <button type="button" className="range-clear" onClick={onClearRange} aria-label="Clear timeline selection">Clear</button></>}</span></div>
      {displayRecords.length === 0 && <div className="no-results"><Search size={24} strokeWidth={1.5} /><h2>{searching ? 'No matching records' : 'No records in this session'}</h2><p>{searching ? 'Try another keyword or clear the search field.' : 'Open a session containing messages to explore its trajectory.'}</p></div>}
      <table className={`${tableCss.table} record-table`} data-scroll-ready="true" aria-rowcount={visibleRecords.length}><colgroup><col className={tableCss.eventColumn} /><col className={tableCss.contentColumn} /></colgroup><tbody>
        {virtual && items.length > 0 && <tr aria-hidden="true" className="virtual-spacer"><td colSpan={2} style={{ height: items[0].start }} /></tr>}
        {items.map(item => {
          const { index } = item
          const record = visibleRecords[index]
          const rowRef = virtual ? virtualizer.measureElement : undefined
          if (record.summaryKind) return <tr ref={rowRef} data-index={index} key={item.key} data-collapsed-summary={record.summaryKind} data-turn-end={record.turnEnd || undefined} tabIndex="0" aria-label={`Expand ${record.summaryKind === 'turn' ? `turn ${record.turn}` : 'tool calls'}: ${record.summary}`} onClick={() => toggleRecord(record)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleRecord(record) } }}><td className={tableCss.event} /><td className={tableCss.content}><span className={tableCss.collapsedTurnContent} title={record.summary}><span className={tableCss.collapsedTurnEllipsis}>…</span><span className={tableCss.collapsedTurnText}>{record.summary}</span></span></td></tr>
          const visibleRecord = searching ? { ...record, turnStart: visibleRecords[index - 1]?.turn !== record.turn, turnEnd: visibleRecords[index + 1]?.turn !== record.turn } : record
          return <Cell key={item.key} rowRef={rowRef} virtualIndex={index} record={visibleRecord} activeTurn={selectedRecord?.turn} selected={record.cell.recordId === selectedId} onSelect={onSelect} onToggle={() => toggleRecord(record)} query={query} focusIndexes={focusIndexes} />
        })}
        {virtual && items.length > 0 && <tr aria-hidden="true" className="virtual-spacer"><td colSpan={2} style={{ height: Math.max(0, virtualizer.getTotalSize() - items.at(-1).end) }} /></tr>}
      </tbody></table>
    </div>
    {selected && <><div className="details-resizer" role="separator" aria-label="Resize details" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={720} aria-valuenow={detailsWidth} tabIndex={0} onDoubleClick={() => setDetailsWidth(480)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setDetailsWidth(value => boundedWidth(value + (event.key === 'ArrowLeft' ? 16 : -16))) } }} onPointerDown={event => { if (event.button !== 0) return; resize.current = { x: event.clientX, width: detailsWidth }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }} onPointerMove={event => { if (resize.current) setDetailsWidth(boundedWidth(resize.current.width + resize.current.x - event.clientX)) }} onPointerUp={() => { resize.current = null }} onPointerCancel={() => { resize.current = null }} onLostPointerCapture={() => { resize.current = null }} /><Detail cell={selected} records={records} onNavigate={onSelect} onClose={() => onSelect(null)} /></>}
  </div>
}

export function Turn({ turn, ...props }) {
  return <TrajectoryTable turns={[turn]} {...props} collapsedTurns={new Set()} />
}
