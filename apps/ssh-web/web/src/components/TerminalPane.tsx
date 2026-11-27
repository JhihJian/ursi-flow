import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { ContextMenu, type MenuState } from './ContextMenu'
import { WindowBar } from './WindowBar'
import type { SearchAddon } from '@xterm/addon-search'
import { openTerminalBridge, type TerminalBridge } from '../terminal/bridge'
import { TerminalSearch } from '../terminal/search'
import { terminalBackground } from '../terminal/theme'
import { useSshContainer, useSshController, useSshStore, terminalStateTo } from '../ssh-context'
import type { TerminalTab } from '../store/ssh-store'

/**
 * 一个终端标签对应的 xterm 面板。所有打开的标签常驻挂载（非激活的 visibility 隐藏，
 * 保持同一盒尺寸，输出照常写入、远端 PTY 不被误 resize），激活时置顶并聚焦。
 * 搜索入口统一由容器快捷键（Ctrl/Cmd+F）下发：searchKey 自增即视为一次请求，仅激活标签响应。
 */
export function TerminalPane({
  tab,
  active,
  searchKey,
  onSearchHandled,
}: {
  /** 对应的终端标签。 */
  tab: TerminalTab
  /** 是否为当前激活标签。 */
  active: boolean
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
  const terminalLight = useSshStore((state) => state.terminalLight)
  const setEditor = useSshStore((state) => state.setEditor)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [ended, setEnded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const focusTerminal = useCallback(() => {
    if (active) bridgeRef.current?.focus()
  }, [active])

  // 新的搜索请求（key 变大）才打开面板；只有激活标签响应，搜索完成时父组件回调推进水位。
  useEffect(() => {
    if (!active) return
    if (searchKey > lastSearchKey.current) {
      lastSearchKey.current = searchKey
      setSearchOpen(true)
    }
  }, [searchKey, active])
  useEffect(() => {
    if (!searchOpen) onSearchHandled()
  }, [searchOpen, onSearchHandled])

  // 建桥生命周期只跟标签身份绑定：同一标签的亮暗切换、激活切换都不重建、不重连。
  // cwd 是身份的一部分（打开后不变，openTerminal 对已打开标签只激活），所以也在依赖里。
  useEffect(() => {
    const host = hostRef.current
    const tooltip = tooltipRef.current
    if (!host || !tooltip) return
    setEnded(null)
    setFailed(null)
    setSearchOpen(false)
    setSearchAddon(null)

    let bridge: TerminalBridge
    try {
      bridge = openTerminalBridge({
        host,
        tooltip,
        target: { connectionId: tab.connectionId, tmuxSession: tab.tmuxSession, cwd: tab.cwd },
        light: store.getState().terminalLight,
        api,
        onState: (state) => {
          store.getState().setTerminalState(tab.key, state)
        },
        onEvent: (event) => {
          store.getState().setTerminalState(tab.key, terminalStateTo(event))
          if (event.kind === 'error') setFailed(event.message)
          else setEnded(event.message)
        },
      })
    } catch (error) {
      // 建桥失败（WS URL 非法、WebGL 初始化异常等）不拖垮整棵 React 树。
      setFailed(error instanceof Error ? error.message : String(error))
      store.getState().setTerminalState(tab.key, 'error')
      return
    }
    bridgeRef.current = bridge
    setSearchAddon(bridge.searchAddon)
    return () => {
      bridgeRef.current = null
      setSearchAddon(null)
      bridge.dispose()
      // 卸载（关闭标签或折叠模块）即断开，采样轮询随之停掉；重展开时重新建桥。
      store.getState().setTerminalState(tab.key, 'closed')
    }
  }, [tab.key, tab.connectionId, tab.tmuxSession, tab.cwd, api, store])

  // 激活时聚焦终端：首次打开与切标签都靠这里。
  useEffect(() => {
    if (active) bridgeRef.current?.focus()
  }, [active, searchAddon])

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

  return (
    <div
      className={
        terminalLight
          ? 'ssh-terminal-pane ssh-terminal-surface light'
          : 'ssh-terminal-pane ssh-terminal-surface'
      }
      style={{ background: surfaceBackground, visibility: active ? 'visible' : 'hidden' }}
      onContextMenu={openMenu}
    >
      {/* window 条只跟激活标签走：非激活面板隐藏时也用不着展示。 */}
      {active ? <WindowBar tab={tab} /> : null}
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
