import { useCallback, useEffect, useState } from 'react'
import {
  deleteSession,
  fetchConfig,
  fetchPrefs,
  updatePrefs,
  type ServerConfig,
  type SessionRow,
} from '@/api'
import { useSessions } from '@/hooks/useSessions'
import { errorMessage } from '@/lib/ui'
import { Workspace } from '@/components/Workspace'

const ROOT_STORAGE_KEY = 'pi-sessions-web:root'

/** 根目录来自 URL、上次选择或服务端默认值，三者按序取第一个可用的。 */
function rememberedRoot(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('root')
  if (fromUrl) return fromUrl
  return window.localStorage.getItem(ROOT_STORAGE_KEY)
}

function rememberRoot(root: string): void {
  window.localStorage.setItem(ROOT_STORAGE_KEY, root)
  const url = new URL(window.location.href)
  url.searchParams.set('root', root)
  window.history.replaceState(null, '', url)
}

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [root, setRoot] = useState<string | null>(rememberedRoot)
  const [query, setQuery] = useState('')
  const [selectedRow, setSelectedRow] = useState<SessionRow | null>(null)
  const [pinnedProjects, setPinnedProjects] = useState<string[]>([])

  useEffect(() => {
    void fetchConfig()
      .then(setConfig)
      .catch((failure: unknown) => setConfigError(errorMessage(failure)))
    void fetchPrefs()
      .then((prefs) => setPinnedProjects(prefs.pinnedProjects))
      .catch(() => setPinnedProjects([]))
  }, [])

  // 没有记住过根就用服务端默认值；只补一次，不覆盖用户的选择。
  useEffect(() => {
    if (!root && config) {
      setRoot(config.defaultRoot)
      rememberRoot(config.defaultRoot)
    }
  }, [root, config])

  const { listing, loading, error, reload } = useSessions(root)

  /**
   * 关注/取消关注：先在本地生效，再落盘。失败时回滚并说明原因，
   * 避免界面显示成功而磁盘没有变化。
   */
  const togglePin = useCallback(
    (projectKey: string, pinned: boolean) => {
      const previous = pinnedProjects
      const next = pinned
        ? [projectKey, ...previous.filter((key) => key !== projectKey)]
        : previous.filter((key) => key !== projectKey)
      setPinnedProjects(next)
      void updatePrefs(pinned ? { pin: projectKey } : { unpin: projectKey })
        .then((prefs) => setPinnedProjects(prefs.pinnedProjects))
        .catch((failure: unknown) => {
          setPinnedProjects(previous)
          alert(`无法保存关注设置：${errorMessage(failure)}`)
        })
    },
    [pinnedProjects],
  )

  /** 删除会话文件：成功后从列表移除，失败时说明原因且不动列表。 */
  const removeSession = useCallback(
    (row: SessionRow) => {
      void deleteSession(root ?? '', row.id)
        .then(() => {
          if (selectedRow?.id === row.id) setSelectedRow(null)
          reload()
        })
        .catch((failure: unknown) => alert(`删除失败：${errorMessage(failure)}`))
    },
    [root, selectedRow?.id, reload],
  )

  const changeRoot = useCallback((next: string) => {
    rememberRoot(next)
    setSelectedRow(null)
    setQuery('')
    setRoot(next)
  }, [])

  if (configError) {
    return (
      <div className="boot">
        <p className="viewer-error">无法读取服务配置：{configError}</p>
        <p className="viewer-hint">确认服务端已启动（默认 http://127.0.0.1:30200）。</p>
      </div>
    )
  }

  if (!root) {
    return (
      <div className="boot">
        <p className="viewer-hint">读取中…</p>
      </div>
    )
  }

  return (
    <Workspace
      root={root}
      listing={listing}
      loading={loading}
      error={error}
      query={query}
      onQueryChange={setQuery}
      selectedRow={selectedRow}
      onSelect={setSelectedRow}
      onReload={reload}
      onRootChange={changeRoot}
      defaultRoot={config?.defaultRoot ?? root}
      suggestedRoots={config?.suggestedRoots ?? []}
      pinnedProjects={pinnedProjects}
      onTogglePin={togglePin}
      onDeleteSession={removeSession}
      canWrite={config?.canWrite ?? false}
    />
  )
}
