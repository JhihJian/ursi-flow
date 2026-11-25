import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { ContextMenu, type MenuState } from './ContextMenu'
import type { SearchAddon } from '@xterm/addon-search'
import { openTerminalBridge, type TerminalBridge } from '../terminal/bridge'
import { TerminalSearch } from '../terminal/search'
import { terminalBackground } from '../terminal/theme'
import { useSshContainer, useSshController, useSshStore, terminalStateTo } from '../ssh-context'

/**
 * 右侧终端区：点会话即经 WS 建 SSH 并 attach。
 * 终端与主题解耦：切亮暗只改 xterm 的 theme，不重建终端也不重连 SSH。
 * 搜索入口统一由容器快捷键（Ctrl/Cmd+F）下发：searchKey 自增即视为一次请求。
 */
export function TerminalPane({
  searchKey,
  onSearchHandled,
}: {
  /** 父组件维护的单调递增计数，自增即一次搜索请求。 */
  searchKey: number
  onSearchHandled: () => void
}) {
  const container = useSshContainer()
  const { store, api } = useSshController()
  const hostRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<TerminalBridge | null>(null)
  const lastSearchKey = useRef(0)
  const terminal = useSshStore((state) => state.terminal)
  const terminalLight = useSshStore((state) => state.terminalLight)
  const setEditor = useSshStore((state) => state.setEditor)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [ended, setEnded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const focusTerminal = useCallback(() => bridgeRef.current?.focus(), [])

  // 新的搜索请求（key 变大）才打开面板；搜索完成时父组件会回调推进已处理水位。
  useEffect(() => {
    if (searchKey > lastSearchKey.current) {
      lastSearchKey.current = searchKey
      setSearchOpen(true)
    }
  }, [searchKey])
  useEffect(() => {
    if (!searchOpen) onSearchHandled()
  }, [searchOpen, onSearchHandled])

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
        light: store.getState().terminalLight,
        api,
        onState: (state) => {
          store.getState().setTerminalState(state)
        },
        onEvent: (event) => {
          store.getState().setTerminalState(terminalStateTo(event))
          if (event.kind === 'error') setFailed(event.message)
          else setEnded(event.message)
        },
      })
    } catch (error) {
      // 建桥失败（WS URL 非法、WebGL 初始化异常等）不拖垮整棵 React 树。
      setFailed(error instanceof Error ? error.message : String(error))
      store.getState().setTerminalState('error')
      return
    }
    bridgeRef.current = bridge
    setSearchAddon(bridge.searchAddon)
    return () => {
      bridgeRef.current = null
      setSearchAddon(null)
      store.getState().setTerminalState('closed')
      bridge.dispose()
    }
  }, [terminal])

  useEffect(() => {
    bridgeRef.current?.setTheme(terminalLight)
  }, [terminalLight, searchAddon])

  const surfaceBackground = useMemo(() => terminalBackground(terminalLight), [terminalLight])

  const openMenu = (event: MouseEvent) => {
    event.preventDefault()
    if (!container) return
    const rect = container.getBoundingClientRect()
    const items: MenuState['items'] = [
      { label: 'New session', onSelect: () => setEditor({ kind: 'new' }) },
      { label: 'Search in terminal', onSelect: () => setSearchOpen(true) },
      {
        label: terminalLight ? 'Dark terminal' : 'Light terminal',
        onSelect: () => store.getState().toggleTerminalLight(),
      },
    ]
    setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top, items })
  }

  if (!terminal) {
    return (
      <div className="ssh-terminal ssh-terminal-placeholder" onContextMenu={openMenu}>
        从左侧选择 tmux 会话，或右键新建
        <ContextMenu state={menu} onClose={() => setMenu(null)} />
      </div>
    )
  }

  return (
    <div
      className={
        terminalLight ? 'ssh-terminal ssh-terminal-surface light' : 'ssh-terminal ssh-terminal-surface'
      }
      style={{ background: surfaceBackground }}
      onContextMenu={openMenu}
    >
      <div className="ssh-terminal-host" ref={hostRef} />
      <div className="ssh-link-tooltip" ref={tooltipRef} style={{ display: 'none' }} />
      <TerminalSearch
        open={searchOpen}
        light={terminalLight}
        searchAddon={searchAddon}
        onClose={() => setSearchOpen(false)}
        onRestoreFocus={focusTerminal}
      />
      {failed ? <div className="ssh-banner ssh-banner-error">{failed}</div> : null}
      {ended ? <div className="ssh-banner ssh-banner-ended">{ended}</div> : null}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
