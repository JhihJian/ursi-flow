// Adapted from DeepSeek ui-trajectory at f3803c9697. Pointer, viewport and range behavior retained.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Tooltip } from './Tooltip.jsx'
import { flattenTurns } from '../lib/trajectory-view.js'
import { deriveTrajectoryTimeline, formatTimelineOffset } from '../lib/timeline.js'
import css from './reference/TrajectoryTimeline.module.css'
const MINIMUM_DRAG_PX = 3
const MINIMUM_ZOOM_OPERATIONS = 4
const EDGE_PAN_ZONE_FRACTION = 0.08
const EDGE_PAN_STEP_FRACTION = 0.025
const MAXIMUM_EDGE_PAN_PX = 32
const TIMELINE_TOOLTIP_DELAY_MS = 500
function assistantTimingDetail(metrics) {
  const start = metrics?.stepStartTime
  const first = metrics?.firstTokenTime
  const completed = metrics?.completedTime
  if (
    metrics?.timingRecorded !== true ||
    typeof start !== 'number' ||
    typeof first !== 'number' ||
    typeof completed !== 'number' ||
    !Number.isFinite(start) ||
    !Number.isFinite(first) ||
    !Number.isFinite(completed) ||
    first < start ||
    completed < first
  )
    return {}
  return { ttftMs: first - start, decodingMs: completed - first }
}
function timelineRecordDetail(cell) {
  const durationMs =
    cell.timeSeconds === null || !Number.isFinite(cell.timeSeconds)
      ? void 0
      : Math.max(0, cell.timeSeconds * 1e3)
  const startedAt =
    cell.startedAt === null || !Number.isFinite(cell.startedAt)
      ? void 0
      : cell.startedAt
  return {
    ...(durationMs === void 0 ? {} : { durationMs }),
    ...(startedAt === void 0 ? {} : { startedAt }),
    ...assistantTimingDetail(cell.assistantMetrics)
  }
}
function timelineKindLabel(kind, t) {
  switch (kind) {
    case 'system':
      return t('kind.system')
    case 'user':
      return t('kind.user')
    case 'context':
      return t('kind.context')
    case 'compacted':
      return t('kind.compacted')
    case 'message':
      return t('kind.assistant')
    case 'tool':
      return t('kind.tool')
    case 'subtool':
      return t('kind.subtool')
  }
}
function formatRecordedTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString(void 0, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}
function timelineTooltipLabel(kind, detail, t) {
  const heading = timelineKindLabel(kind, t)
  if (detail === void 0) return heading
  const duration =
    detail.durationMs === void 0
      ? null
      : t('timeline.total', {
          duration: formatTimelineOffset(detail.durationMs, t)
        })
  const range =
    detail.startedAt === void 0
      ? null
      : detail.durationMs === void 0
        ? t('timeline.started', { time: formatRecordedTime(detail.startedAt) })
        : `${formatRecordedTime(detail.startedAt)} \u2192 ${formatRecordedTime(
            detail.startedAt + detail.durationMs
          )}`
  const segments =
    detail.ttftMs === void 0 || detail.decodingMs === void 0
      ? null
      : t('timeline.ttftDecoding', {
          ttft: formatTimelineOffset(detail.ttftMs, t),
          decoding: formatTimelineOffset(detail.decodingMs, t)
        })
  const timing = [duration, segments]
    .filter((value) => value !== null)
    .join(' \xB7 ')
  return [heading, range, timing]
    .filter((value) => value !== null && value !== '')
    .join('\n')
}
function orderedRange(left, right) {
  return left <= right
    ? { start: left, end: right }
    : { start: right, end: left }
}
function clampFraction(value) {
  return Math.min(1, Math.max(0, value))
}
function centeredRange(center, width, minimum, maximum) {
  const clampedWidth = Math.min(maximum - minimum, Math.max(0, width))
  const start = Math.min(
    Math.max(center - clampedWidth / 2, minimum),
    maximum - clampedWidth
  )
  return { start, end: start + clampedWidth }
}
function rangeFraction(range, start, duration, minimum, maximum) {
  const bounded = orderedRange(
    Math.min(maximum, Math.max(minimum, range.start)),
    Math.min(maximum, Math.max(minimum, range.end))
  )
  return {
    start: (bounded.start - start) / duration,
    end: (bounded.end - start) / duration
  }
}
function LaneLabels({ t }) {
  return (
    <div className={css.labels} aria-hidden="true">
      <span>{t('column.input')}</span>
      <span>{t('column.model')}</span>
      <span>{t('column.tools')}</span>
    </div>
  )
}
function EarlierHistoryBoundary({ loading, onHover, onLoad, t }) {
  return (
    <Tooltip
      label={
        loading ? t('history.loadingEarlier') : t('history.clickToLoadEarlier')
      }
      side="right"
      delayMs={TIMELINE_TOOLTIP_DELAY_MS}
    >
      <button
        type="button"
        className={css.earlierHistory}
        data-earlier-history
        data-loading={loading || void 0}
        aria-label={
          loading ? t('history.loadingEarlierAria') : t('history.loadEarlier')
        }
        aria-disabled={loading || onLoad === void 0}
        onClick={onLoad}
        onPointerEnter={(event) => {
          event.stopPropagation()
          onHover()
        }}
        onPointerMove={(event) => {
          event.stopPropagation()
        }}
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
      >
        …
      </button>
    </Tooltip>
  )
}
const TrajectoryTimeline = memo(function TrajectoryTimeline2({
  t,
  turns,
  mode,
  range,
  hasEarlierRecords = false,
  onLoadEarlier,
  selectedIndex = null,
  searchMatchIndexes = null,
  onRangeChange,
  onRecordSelect,
  onRecordFocus
}) {
  const model = useMemo(
    () => deriveTrajectoryTimeline(turns, mode),
    [mode, turns]
  )
  const detailByIndex = useMemo(
    () =>
      new Map(
        flattenTurns(turns).map(({ cell, position }) => [
          position,
          timelineRecordDetail(cell)
        ])
      ),
    [turns]
  )
  const dragRef = useRef(null)
  const panRef = useRef(null)
  const rootRef = useRef(null)
  const trackRef = useRef(null)
  const [draft, setDraft] = useState(null)
  const [hover, setHover] = useState(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [panning, setPanning] = useState(false)
  const [viewport, setViewport] = useState(null)
  const [animateViewport, setAnimateViewport] = useState(false)
  const [keyboardIndex, setKeyboardIndex] = useState(null)
  const activeIndex = keyboardIndex ?? selectedIndex
  useEffect(() => {
    setKeyboardIndex(null)
  }, [selectedIndex])
  useEffect(() => {
    if (keyboardIndex !== null)
      trackRef.current
        ?.querySelector(`[data-timeline-record-index="${keyboardIndex}"]`)
        ?.focus({ preventScroll: true })
  }, [keyboardIndex])
  useEffect(() => {
    if (
      model !== null &&
      range !== null &&
      (range.end < model.start || range.start > model.end)
    ) {
      onRangeChange(null)
    }
  }, [model, onRangeChange, range])
  useEffect(() => {
    if (model === null) return
    setAnimateViewport(false)
    setViewport((current) =>
      current !== null &&
      (current.end < model.start || current.start > model.end)
        ? null
        : current
    )
  }, [model])
  useEffect(() => {
    if (model === null || activeIndex === null) return
    const selectedSpan = model.spans.find((span) => span.index === activeIndex)
    if (selectedSpan === void 0) return
    setAnimateViewport(true)
    setViewport((current) => {
      if (current === null) return current
      if (selectedSpan.end > current.start && selectedSpan.start < current.end)
        return current
      const duration = Math.max(1, current.end - current.start)
      const desiredStart =
        selectedSpan.end <= current.start
          ? selectedSpan.start
          : selectedSpan.end - duration
      const nextStart = Math.min(
        Math.max(desiredStart, model.start),
        Math.max(model.start, model.end - duration)
      )
      if (nextStart === current.start) return current
      return { start: nextStart, end: nextStart + duration }
    })
  }, [model, activeIndex])
  const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0))
  const viewportDuration = Math.min(
    fullDuration,
    Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0))
  )
  const viewportStart =
    model === null || viewport === null
      ? (model?.start ?? 0)
      : Math.min(
          Math.max(viewport.start, model.start),
          model.end - viewportDuration
        )
  const domainDuration = viewport === null ? fullDuration : viewportDuration
  const domainStart = viewport === null ? (model?.start ?? 0) : viewportStart
  const showsEarlierBoundary =
    hasEarlierRecords && model !== null && domainStart === model.start
  const loadEarlier =
    onLoadEarlier === void 0 || loadingEarlier
      ? void 0
      : () => {
          setLoadingEarlier(true)
          void onLoadEarlier().finally(() => {
            setLoadingEarlier(false)
          })
        }
  const projectedDomainStyle =
    model === null
      ? void 0
      : {
          '--trajectory-domain-left': `${(-(domainStart - model.start) / domainDuration) * 100}%`,
          '--trajectory-domain-width': `${(fullDuration / domainDuration) * 100}%`
        }
  const committed =
    model === null || range === null
      ? null
      : rangeFraction(
          range,
          domainStart,
          domainDuration,
          model.start,
          model.end
        )
  const draftFraction =
    model === null || draft === null
      ? null
      : rangeFraction(
          draft,
          domainStart,
          domainDuration,
          model.start,
          model.end
        )
  const visibleRange = draftFraction ?? committed
  const activeRange = draft ?? range
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const onWheel = (event) => {
      event.preventDefault()
      const track = trackRef.current
      if (track === null || model === null) return
      setAnimateViewport(false)
      const rect = track.getBoundingClientRect()
      const anchorFraction = clampFraction(
        (event.clientX - rect.left) / Math.max(1, rect.width)
      )
      const nextDuration = Math.min(
        fullDuration,
        Math.max(
          Math.min(
            mode === 'sequence' ? MINIMUM_ZOOM_OPERATIONS : 20,
            fullDuration
          ),
          domainDuration * Math.exp(event.deltaY * 15e-4)
        )
      )
      if (nextDuration >= fullDuration * 0.999) {
        setViewport(null)
        return
      }
      const anchorTime = domainStart + anchorFraction * domainDuration
      const nextStart = Math.min(
        Math.max(anchorTime - anchorFraction * nextDuration, model.start),
        model.end - nextDuration
      )
      setViewport({ start: nextStart, end: nextStart + nextDuration })
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      root.removeEventListener('wheel', onWheel)
    }
  }, [domainDuration, domainStart, fullDuration, mode, model])
  if (model === null) {
    return (
      <section
        ref={rootRef}
        className={css.root}
        aria-label={t('timeline.aria')}
      >
        <div className={css.plot}>
          <LaneLabels t={t} />
          <div className={`${css.track} timeline-track`}>
            <span className={css.empty}>{t('timeline.noTimingData')}</span>
            {hasEarlierRecords && (
              <EarlierHistoryBoundary
                loading={loadingEarlier}
                onHover={() => {
                  setHover(null)
                }}
                onLoad={loadEarlier}
                t={t}
              />
            )}
          </div>
        </div>
      </section>
    )
  }
  const minimumSelectionDuration = Math.min(
    domainDuration,
    fullDuration / model.spans.length
  )
  const fractionAt = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width))
  }
  const recordIndexAt = (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const value = target?.closest('[data-timeline-record-index]')?.dataset
      .timelineRecordIndex
    if (value === void 0) return null
    const index = Number(value)
    return Number.isFinite(index) ? index : null
  }
  const commit = (nextRange) => {
    onRangeChange(nextRange)
  }
  const onPointerDown = (event) => {
    event.currentTarget.focus({ preventScroll: true })
    if (event.button === 2) {
      panRef.current = {
        anchorClientX: event.clientX,
        anchorStart: domainStart,
        moved: false,
        pannable: viewport !== null,
        pointerId: event.pointerId
      }
      if (viewport !== null) setAnimateViewport(false)
      setPanning(true)
      if (typeof event.currentTarget.setPointerCapture === 'function') {
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      return
    }
    if (event.button !== 0) return
    const anchor = fractionAt(event)
    const anchorTime = domainStart + anchor * domainDuration
    const recordIndex = recordIndexAt(event)
    setHover({ fraction: anchor, recordIndex })
    dragRef.current = {
      pointerId: event.pointerId,
      anchorTime,
      anchorClientX: event.clientX,
      recordIndex
    }
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    setDraft({ start: anchorTime, end: anchorTime })
  }
  const onPointerMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = fractionAt(event)
    setHover({ fraction, recordIndex: recordIndexAt(event) })
    const pan = panRef.current
    if (pan !== null && pan.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) {
        pan.moved = true
      }
      if (!pan.pannable) return
      const delta =
        (event.clientX - pan.anchorClientX) / Math.max(1, rect.width)
      const nextStart = Math.min(
        Math.max(pan.anchorStart - delta * domainDuration, model.start),
        model.end - domainDuration
      )
      setViewport({ start: nextStart, end: nextStart + domainDuration })
      return
    }
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    let nextDomainStart = domainStart
    if (viewport !== null) {
      const localX = event.clientX - rect.left
      const edgeWidth = Math.min(
        MAXIMUM_EDGE_PAN_PX,
        Math.max(1, rect.width * EDGE_PAN_ZONE_FRACTION)
      )
      const direction =
        localX < edgeWidth ? -1 : localX > rect.width - edgeWidth ? 1 : 0
      if (direction !== 0) {
        const edgeDistance =
          direction < 0 ? edgeWidth - localX : localX - (rect.width - edgeWidth)
        const strength = clampFraction(edgeDistance / edgeWidth)
        const desiredStart =
          domainStart +
          direction *
            domainDuration *
            EDGE_PAN_STEP_FRACTION *
            Math.max(0.2, strength)
        nextDomainStart = Math.min(
          Math.max(desiredStart, model.start),
          model.end - domainDuration
        )
        if (nextDomainStart !== domainStart) {
          setAnimateViewport(false)
          setViewport({
            start: nextDomainStart,
            end: nextDomainStart + domainDuration
          })
        }
      }
    }
    const pointTime = nextDomainStart + fraction * domainDuration
    setDraft(orderedRange(drag.anchorTime, pointTime))
  }
  const onPointerEnd = (event) => {
    const pan = panRef.current
    if (pan !== null && pan.pointerId === event.pointerId) {
      const moved =
        pan.moved ||
        Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX
      panRef.current = null
      setPanning(false)
      if (!moved) onRangeChange(null)
      return
    }
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const pointFraction = fractionAt(event)
    const pointTime = domainStart + pointFraction * domainDuration
    const selected = orderedRange(drag.anchorTime, pointTime)
    setHover({ fraction: pointFraction, recordIndex: recordIndexAt(event) })
    dragRef.current = null
    setDraft(null)
    const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX
    const clickedSpan =
      click && drag.recordIndex !== null
        ? model.spans.find((span) => span.index === drag.recordIndex)
        : void 0
    if (clickedSpan !== void 0) {
      onRangeChange(null)
      onRecordSelect?.(clickedSpan.index)
      return
    }
    const committedRange =
      selected.end - selected.start < minimumSelectionDuration
        ? centeredRange(
            click ? selected.start : (selected.start + selected.end) / 2,
            minimumSelectionDuration,
            model.start,
            model.end
          )
        : selected
    commit(committedRange)
    if (click) {
      const timelinePoint = selected.start
      const nearest = model.spans.reduce((candidate, span) => {
        const candidateDistance =
          timelinePoint < candidate.start
            ? candidate.start - timelinePoint
            : timelinePoint > candidate.end
              ? timelinePoint - candidate.end
              : 0
        const spanDistance =
          timelinePoint < span.start
            ? span.start - timelinePoint
            : timelinePoint > span.end
              ? timelinePoint - span.end
              : 0
        return spanDistance < candidateDistance ? span : candidate
      })
      onRecordFocus?.(nearest.index)
    }
  }
  const onKeyDown = (event) => {
    if (event.key === 'Home') {
      event.preventDefault()
      setViewport(null)
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    onPointerCancel()
    onRangeChange(null)
  }
  const onPointerCancel = () => {
    dragRef.current = null
    panRef.current = null
    setDraft(null)
    setHover(null)
    setPanning(false)
  }
  return (
    <section ref={rootRef} className={css.root} aria-label={t('timeline.aria')}>
      <div className={css.plot}>
        <LaneLabels t={t} />
        <div
          ref={trackRef}
          className={`${css.track} timeline-track`}
          data-panning={panning || void 0}
          data-viewport-start={domainStart}
          data-viewport-end={domainStart + domainDuration}
          aria-label={t('timeline.overviewAria')}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onPointerCancel}
          onPointerLeave={() => {
            if (dragRef.current === null && panRef.current === null)
              setHover(null)
          }}
          onDoubleClick={(event) => {
            event.preventDefault()
            onRangeChange(null)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
          }}
        >
          {showsEarlierBoundary && (
            <EarlierHistoryBoundary
              loading={loadingEarlier}
              onHover={() => {
                setHover(null)
              }}
              onLoad={loadEarlier}
              t={t}
            />
          )}
          {hover !== null && hover.recordIndex === null && draft === null && (
            <div
              className={css.hoverLine}
              data-timeline-hover-line
              aria-hidden="true"
              style={{
                '--trajectory-hover-left': `${hover.fraction * 100}%`
              }}
            />
          )}
          {visibleRange !== null && (
            <>
              <div
                className={css.selection}
                data-dragging={draft === null ? void 0 : 'true'}
                aria-hidden="true"
                style={{
                  '--trajectory-selection-left': `${visibleRange.start * 100}%`,
                  '--trajectory-selection-width': `${(visibleRange.end - visibleRange.start) * 100}%`
                }}
              />
              <div
                className={css.selectionEdges}
                data-dragging={draft === null ? void 0 : 'true'}
                aria-hidden="true"
                style={{
                  '--trajectory-selection-left': `${visibleRange.start * 100}%`,
                  '--trajectory-selection-width': `${(visibleRange.end - visibleRange.start) * 100}%`
                }}
              />
            </>
          )}
          <div
            className={css.turnBoundaries}
            data-animate-viewport={animateViewport || void 0}
            aria-hidden="true"
            style={projectedDomainStyle}
          >
            {model.turnBoundaries
              .filter(
                (boundary) =>
                  boundary.time >= model.start &&
                  boundary.time >= domainStart &&
                  boundary.time <= domainStart + domainDuration
              )
              .map((boundary) => (
                <span
                  className={css.turnBoundary}
                  data-turn={boundary.turn}
                  key={boundary.turn}
                  style={{
                    '--trajectory-turn-left': `${((boundary.time - model.start) / fullDuration) * 100}%`
                  }}
                />
              ))}
          </div>
          <div
            className={css.lanes}
            data-animate-viewport={animateViewport || void 0}
            data-timeline-domain
            style={projectedDomainStyle}
          >
            {model.spans
              .filter(
                (span) =>
                  span.index === activeIndex ||
                  span.index === selectedIndex ||
                  (span.end >= domainStart &&
                    span.start <= domainStart + domainDuration)
              )
              .map((span) => {
                const left = (span.start - model.start) / fullDuration
                const width = (span.end - span.start) / fullDuration
                const widthPercent = width * 100
                const detail = detailByIndex.get(span.index)
                const ttftMs = detail?.ttftMs
                const decodingMs = detail?.decodingMs
                const ttftFraction =
                  ttftMs === void 0 ||
                  decodingMs === void 0 ||
                  ttftMs + decodingMs <= 0
                    ? null
                    : ttftMs / (ttftMs + decodingMs)
                return (
                  <Tooltip
                    key={span.index}
                    label={() => timelineTooltipLabel(span.kind, detail, t)}
                    side="bottom"
                    delayMs={TIMELINE_TOOLTIP_DELAY_MS}
                  >
                    <span
                      role="button"
                      tabIndex={
                        span.index === (activeIndex ?? model.spans[0]?.index)
                          ? 0
                          : -1
                      }
                      aria-label={`${timelineKindLabel(span.kind, t)} ${span.label}`}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'ArrowLeft' ||
                          event.key === 'ArrowRight'
                        ) {
                          event.preventDefault()
                          event.stopPropagation()
                          const offset = event.key === 'ArrowLeft' ? -1 : 1
                          const current = model.spans.findIndex(
                            (item) => item.index === span.index
                          )
                          const next =
                            model.spans[
                              Math.max(
                                0,
                                Math.min(
                                  model.spans.length - 1,
                                  current + offset
                                )
                              )
                            ]
                          setKeyboardIndex(next.index)
                          trackRef.current
                            ?.querySelector(
                              `[data-timeline-record-index="${next.index}"]`
                            )
                            ?.focus({ preventScroll: true })
                        }
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onRangeChange(null)
                          onRecordSelect?.(span.index)
                        }
                      }}
                      className={css.span}
                      data-timeline-span={span.kind}
                      data-timeline-record-index={span.index}
                      data-timeline-record-id={span.recordId}
                      data-assistant-timing={
                        ttftFraction === null ? void 0 : 'true'
                      }
                      data-error={span.isError || void 0}
                      data-current={span.index === selectedIndex || void 0}
                      data-hovered={hover?.recordIndex === span.index || void 0}
                      data-search-match={
                        searchMatchIndexes === null
                          ? void 0
                          : searchMatchIndexes.has(span.index)
                            ? 'true'
                            : 'false'
                      }
                      data-selected={
                        activeRange === null
                          ? void 0
                          : span.start <= activeRange.end &&
                              span.end >= activeRange.start
                            ? 'true'
                            : 'false'
                      }
                      style={{
                        '--trajectory-span-left': `${left * 100}%`,
                        '--trajectory-span-width': `${widthPercent}%`,
                        '--trajectory-span-gap': `min(${widthPercent * 0.08}%, 1px)`,
                        '--trajectory-span-lane': span.lane,
                        ...(ttftFraction === null
                          ? {}
                          : {
                              '--trajectory-assistant-ttft': `${ttftFraction * 100}%`
                            })
                      }}
                    />
                  </Tooltip>
                )
              })}
          </div>
        </div>
      </div>
    </section>
  )
})
export { TrajectoryTimeline }
