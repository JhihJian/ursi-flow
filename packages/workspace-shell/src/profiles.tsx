import { useMemo, useSyncExternalStore } from 'react'
import type { WorkspaceModule, WorkspaceProfile } from './contracts'

/**
 * profile 的可配置版本：宿主用 `createProfilesStore` 建一份存储（默认值 + localStorage），
 * 把 store 同时交给 `WorkspaceShell` 的 `profiles` 与 `ProfilesEditor`。
 * 存储只认 id / title / modules 三个字段，读到坏数据就整份退回默认，不让工作台起不来。
 */
export interface ProfilesStoreOptions {
  storageKey: string
  defaults: WorkspaceProfile[]
}

export interface ProfilesStore {
  /** 当前配置；配合 `useProfiles` 订阅，或直接读一次。 */
  getSnapshot: () => WorkspaceProfile[]
  subscribe: (listener: () => void) => () => void
  /** 整体替换并立即写盘；编辑视图每次改动都走这里。 */
  replace: (profiles: WorkspaceProfile[]) => void
  /** 丢弃自定义配置，恢复默认值。 */
  reset: () => void
}

function profilesKey(storageKey: string): string {
  return `${storageKey}:profiles`
}

function sanitizeProfiles(raw: unknown): WorkspaceProfile[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const ids = new Set<string>()
  const profiles: WorkspaceProfile[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { id, title, modules } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) continue
    if (!Array.isArray(modules)) continue
    ids.add(id)
    profiles.push({
      id,
      title: typeof title === 'string' && title.trim() ? title : id,
      modules: modules.filter((moduleId): moduleId is string => typeof moduleId === 'string'),
    })
  }
  return profiles.length ? profiles : null
}

function loadProfiles(storageKey: string, defaults: WorkspaceProfile[]): WorkspaceProfile[] {
  try {
    const raw = window.localStorage.getItem(profilesKey(storageKey))
    if (!raw) return defaults
    return sanitizeProfiles(JSON.parse(raw)) ?? defaults
  } catch (error) {
    console.error(error)
    return defaults
  }
}

function saveProfiles(storageKey: string, profiles: WorkspaceProfile[]): void {
  try {
    window.localStorage.setItem(profilesKey(storageKey), JSON.stringify(profiles))
  } catch (error) {
    console.error(error)
  }
}

/**
 * 组合根建一次 store，编辑页与外壳读同一份快照。
 * 组件因此不需要把 profile 列表透传成 props，改配置不会重建编辑组件本身（输入框不丢焦点）。
 */
export function createProfilesStore({ storageKey, defaults }: ProfilesStoreOptions): ProfilesStore {
  let profiles = loadProfiles(storageKey, defaults)
  const listeners = new Set<() => void>()
  const commit = (next: WorkspaceProfile[]) => {
    profiles = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => profiles,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    replace: (next) => {
      saveProfiles(storageKey, next)
      commit(next)
    },
    reset: () => {
      try {
        window.localStorage.removeItem(profilesKey(storageKey))
      } catch (error) {
        console.error(error)
      }
      commit(defaults)
    },
  }
}

/** 订阅 store；配置变化时宿主与编辑页一起重渲染。 */
export function useProfiles(store: ProfilesStore): WorkspaceProfile[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** profile 编辑视图的 props；宿主把它注册成 views 里的一项即可。 */
export interface ProfilesEditorProps {
  modules: WorkspaceModule[]
  store: ProfilesStore
}

/** 新 profile 的 id 只在这里生成，稳定后不再变，避免已有展开状态与分栏尺寸失效。 */
function nextProfileId(profiles: WorkspaceProfile[]): string {
  let index = profiles.length + 1
  while (profiles.some((profile) => profile.id === `profile-${index}`)) index += 1
  return `profile-${index}`
}

/**
 * profile 配置页：定义有哪些 profile，每个 profile 启用哪些模块、按什么顺序堆叠。
 * 改动直接写 store，页内不存第二份状态，标题栏切换器与这一页永远一致。
 */
export function ProfilesEditor({ modules, store }: ProfilesEditorProps) {
  const profiles = useProfiles(store)
  const moduleById = useMemo(
    () => new Map(modules.map((module) => [module.id, module])),
    [modules],
  )

  const patch = (index: number, next: Partial<WorkspaceProfile>) => {
    store.replace(
      profiles.map((profile, current) => (current === index ? { ...profile, ...next } : profile)),
    )
  }
  const setModules = (index: number, moduleIds: string[]) => patch(index, { modules: moduleIds })

  return (
    <div className="ws-profiles">
      <div className="ws-profiles-head">
        <h2 className="ws-profiles-title">Profiles</h2>
        <div className="ws-profiles-actions">
          <button
            type="button"
            className="ws-profiles-button"
            onClick={() =>
              store.replace([
                ...profiles,
                {
                  id: nextProfileId(profiles),
                  title: '新 profile',
                  modules: modules.map((module) => module.id),
                },
              ])
            }
          >
            新建 profile
          </button>
          <button
            type="button"
            className="ws-profiles-button"
            onClick={() => {
              if (window.confirm('恢复默认 profile 配置？当前自定义的 profile 会被覆盖。')) {
                store.reset()
              }
            }}
          >
            恢复默认
          </button>
        </div>
      </div>
      <p className="ws-profiles-hint">
        profile 只声明启用哪些模块与顺序：列表自上而下就是侧边栏堆叠顺序。改动立即保存到本机，
        标题栏切换器同步更新。
      </p>

      {profiles.map((profile, index) => {
        const enabledIds = profile.modules.filter((id) => moduleById.has(id))
        const disabled = modules.filter((module) => !enabledIds.includes(module.id))
        const move = (from: number, to: number) => {
          if (to < 0 || to >= enabledIds.length) return
          const next = [...enabledIds]
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          setModules(index, next)
        }
        return (
          <section key={profile.id} className="ws-profile-card">
            <div className="ws-profiles-card-head">
              <input
                className="ws-profile-name"
                value={profile.title}
                aria-label={`profile ${profile.id} 名称`}
                onChange={(event) => patch(index, { title: event.target.value })}
              />
              <span className="ws-profile-id">{profile.id}</span>
              <button
                type="button"
                className="ws-profiles-button"
                disabled={profiles.length <= 1}
                title={profiles.length <= 1 ? '至少保留一个 profile' : undefined}
                onClick={() => store.replace(profiles.filter((_, current) => current !== index))}
              >
                删除
              </button>
            </div>

            <div className="ws-profile-group-title">启用模块 · {enabledIds.length}</div>
            {enabledIds.length === 0 ? (
              <p className="ws-profiles-empty">还没有启用任何模块，从下面的未启用列表里添加。</p>
            ) : (
              <ol className="ws-profile-modules">
                {enabledIds.map((moduleId, position) => (
                  <li key={moduleId} className="ws-profile-module">
                    <span className="ws-profile-order">{position + 1}</span>
                    <span className="ws-profile-module-title">
                      {moduleById.get(moduleId)?.title ?? moduleId}
                    </span>
                    <span className="ws-profile-module-id">{moduleId}</span>
                    <button
                      type="button"
                      className="ws-profile-icon"
                      aria-label={`上移 ${moduleId}`}
                      disabled={position === 0}
                      onClick={() => move(position, position - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ws-profile-icon"
                      aria-label={`下移 ${moduleId}`}
                      disabled={position === enabledIds.length - 1}
                      onClick={() => move(position, position + 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="ws-profile-icon"
                      aria-label={`移除 ${moduleId}`}
                      onClick={() => setModules(index, enabledIds.filter((id) => id !== moduleId))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ol>
            )}

            {disabled.length ? (
              <>
                <div className="ws-profile-group-title">未启用</div>
                <div className="ws-profile-add">
                  {disabled.map((module) => (
                    <button
                      key={module.id}
                      type="button"
                      className="ws-profiles-button"
                      onClick={() => setModules(index, [...enabledIds, module.id])}
                    >
                      ＋ {module.title}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
