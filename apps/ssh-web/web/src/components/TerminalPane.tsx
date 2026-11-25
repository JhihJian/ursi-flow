import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { ContextMenu, type MenuState } from './ContextMenu'
import type { SearchAddon } from '@xterm/addon-search'
import { openTerminalBridge, type TerminalBridge } from '../terminal/bridge'
import { TerminalSearch } from '../terminal/search'
import { terminalBackground } from '../terminal/theme'
import { useSshStore } from '../store/ssh-store'

/**
 * 右侧终端区：点会话即经 WS 建 SSH 并 attach。
 * 终端与主题解耦：切亮暗只改 xterm 的 theme，不重建终端也不重连 SSH。
 */
export function TerminalPane() {
  const hostRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<TerminalBridge | null>(null)
  const terminal = useSshStore((state) => state.terminal)
  const terminalLight = useSshStore((state) => state.terminalLight)
  const setEditor = useSshStore((state) => state.setEditor)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [ended, setEnded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const focusTerminal = useCallback(() => bridgeRef.current?.focus(), [])

  useEffect(() => {
    const host = hostRef.current
    const tooltip = tooltipRef.current
    if (!host || !tooltip || !terminal) return
    setEnded(null)
    setFailed(null)
    setSearchOpen(false)
    setSearchAddon(null)

    let bridge: TerminalBridge
    try {
      bridge = openTerminalBridge({
        host,
        tooltip,
        target: terminal,
        light: useSshStore.getState().terminalLight,
        onEvent: (event) => {
          if (event.kind === 'error') setFailed(event.message)
          else setEnded(event.message)
        },
        onSearchRequest: () => setSearchOpen(true),
      })
    } catch (error) {
      // 建桥失败（WS URL 非法、WebGL 初始化异常等）不拖垮整棵 React 树。
      setEnded(error instanceof Error ? error.message : String(error))
      return
    }
    bridgeRef.current = bridge
    setSearchAddon(bridge.searchAddon)
    return () => {
      bridgeRef.current = null
      setSearchAddon(null)
      bridge.dispose()
    }
  }, [terminal])

  useEffect(() => {
    bridgeRef.current?.setTheme(terminalLight)
  }, [terminalLight, searchAddon])

  const surfaceBackground = useMemo(() => terminalBackground(terminalLight), [terminalLight])

  const openMenu = (event: MouseEvent) => {
    event.preventDefault()
    const items: MenuState['items'] = [
      { label: 'New session', onSelect: () => setEditor({ kind: 'new' }) },
      { label: 'Search in terminal', onSelect: () => setSearchOpen(true) },
      {
        label: terminalLight ? 'Dark terminal' : 'Light terminal',
        onSelect: () => useSshStore.getState().toggleTerminalLight(),
      },
    ]
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  if (!terminal) {
    return (
      <div className="terminal-pane terminal-placeholder" onContextMenu={openMenu}>
        从右侧选择 tmux 会话，或右键新建
        <ContextMenu state={menu} onClose={() => setMenu(null)} />
      </div>
    )
  }

  return (
    <div
      className={terminalLight ? 'terminal-pane terminal-surface light' : 'terminal-pane terminal-surface'}
      style={{ background: surfaceBackground }}
      onContextMenu={openMenu}
    >
      <div className="terminal-host" ref={hostRef} />
      <div className="terminal-link-tooltip" ref={tooltipRef} style={{ display: 'none' }} />
      <TerminalSearch
        open={searchOpen}
        light={terminalLight}
        searchAddon={searchAddon}
        onClose={() => setSearchOpen(false)}
        onRestoreFocus={focusTerminal}
      />
      {failed ? <div className="terminal-banner terminal-banner-error">{failed}</div> : null}
      {ended ? <div className="terminal-banner terminal-banner-ended">{ended}</div> : null}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
