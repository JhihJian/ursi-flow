import React, { cloneElement, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function Tooltip({ label, delayMs = 500, children }) {
  const [point, setPoint] = useState(null)
  const timer = useRef(null)
  const id = useId()
  const hide = () => { clearTimeout(timer.current); setPoint(null) }
  useEffect(() => () => clearTimeout(timer.current), [])
  const show = event => {
    const rect = event.currentTarget.getBoundingClientRect()
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setPoint({ left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 250)), top: rect.bottom + 8 }), delayMs)
  }
  return <>{cloneElement(children, {
    'aria-describedby': point ? id : undefined,
    onPointerEnter: show, onPointerLeave: hide, onPointerDown: hide,
    onFocus: show, onBlur: hide,
  })}{point && createPortal(<div id={id} role="tooltip" className="timeline-tooltip" style={point}>{typeof label === 'function' ? label() : label}</div>, document.body)}</>
}
