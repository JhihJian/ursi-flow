import React from 'react'
import { Clock3, Search, X } from 'lucide-react'
import toolbarCss from './reference/TrajectoryToolbar.module.css'

export function TrajectoryToolbar({ query, setQuery, actualDuration, setActualDuration, allTurnsCollapsed, onToggleTurns, allAssistantsCollapsed, onToggleAssistants }) {
  return <div className={`${toolbarCss.root} viewer-toolbar`} role="toolbar" aria-label="Trajectory toolbar">
    <div className={toolbarCss.inner}>
      <div className={`${toolbarCss.actions} trajectory-controls`}>
        <button className={`${toolbarCss.toggle} duration-toggle`} type="button" aria-label="Use recorded duration" aria-pressed={actualDuration} title={actualDuration ? 'Use equal-width blocks' : 'Use recorded duration'} onClick={() => setActualDuration(!actualDuration)}><Clock3 className={toolbarCss.toggleIcon} size={12} /> Duration</button>
        <button className={toolbarCss.action} type="button" aria-label={allTurnsCollapsed ? 'Expand all turns' : 'Collapse all turns'} aria-pressed={allTurnsCollapsed} title={allTurnsCollapsed ? 'Expand all turns' : 'Collapse all turns'} onClick={onToggleTurns}><span className={toolbarCss.actionIcon} aria-hidden="true">{allTurnsCollapsed ? '⊞' : '⊟'}</span> Turns</button>
        <button className={toolbarCss.action} type="button" aria-label={allAssistantsCollapsed ? 'Expand all tool calls' : 'Collapse all tool calls'} aria-pressed={allAssistantsCollapsed} title={allAssistantsCollapsed ? 'Expand all tool calls' : 'Collapse all tool calls'} onClick={onToggleAssistants}><span className={toolbarCss.actionIcon} aria-hidden="true">{allAssistantsCollapsed ? '⊞' : '⊟'}</span> Calls</button>
      </div>
      <div className={`${toolbarCss.search} search-field`}><Search size={11} className={toolbarCss.searchIcon} /><input className={toolbarCss.searchInput} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search trajectory" aria-label="Search trajectory" />{query && <button className="clear-search" type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}</div>
    </div>
  </div>
}
