import { useCallback, useState } from 'react'
import { parse } from '@ursi/location'
import { DirBrowser } from '@ursi/directory-picker'
import { useAppStore } from '../../../pi-store'
import { api } from '../api/client'
import type { ListDirFn } from '@ursi/directory-picker'
import type { HomeCreateMode, HomeSummary } from '../api/types'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'

export type SectionId =
  | 'general'
  | 'models'
  | 'skills'
  | 'agents'
  | 'plugins'
  | 'mcp'

export const SECTIONS: Array<{ id: SectionId; label: string; icon: string }> = [
  { id: 'general', label: '常规', icon: '⚙' },
  { id: 'models', label: '模型配置', icon: '🧠' },
  { id: 'skills', label: 'Skills', icon: '✦' },
  { id: 'agents', label: 'Subagent', icon: '☷' },
  { id: 'plugins', label: '插件', icon: '⬢' },
  { id: 'mcp', label: 'MCP', icon: '⇄' },
]

const SOURCE_LABEL: Record<HomeSummary['sources'][number], string> = {
  default: '默认',
  env: 'ENV',
  user: '本机',
  manual: '清单',
}

const MODE_OPTIONS: Array<{ value: HomeCreateMode; label: string; hint: string }> = [
  { value: 'init', label: '初始化', hint: '新建目录并生成默认配置' },
  { value: 'clone', label: '复制', hint: '从另一份 home 复制配置' },
  { value: 'adopt', label: '登记', hint: '登记已有目录' },
]

function summaryLine(home: HomeSummary): string {
  if (home.error) return home.error
  if (!home.valid) return '缺 settings.json'
  const parts = [`${home.skills} skill`, `${home.agents} agent`, `${home.mcpServers} mcp`]
  if (home.packages > 0) parts.push(`${home.packages} 插件`)
  return parts.join(' · ')
}

/** 行内输入：回车提交、Esc 取消、失焦提交（与 fs-web 的 WorkspaceList 同语义）。 */
function InlineInput({
  initial,
  placeholder,
  onDone,
}: {
  initial: string
  placeholder: string
  onDone: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <input
      className="preset-inline-input"
      value={value}
      placeholder={placeholder}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(value)
        if (e.key === 'Escape') onDone(initial)
      }}
    />
  )
}

type EditingField = 'name' | 'description' | null

type OpenMenu = (x: number, y: number, items: MenuItem[], heading?: string) => void

function HomeItem({
  home,
  active,
  onSelect,
  openMenu,
}: {
  home: HomeSummary
  active: boolean
  onSelect: () => void
  openMenu: OpenMenu
}) {
  const updateHome = useAppStore((s) => s.updateHome)
  const removeHome = useAppStore((s) => s.removeHome)
  const createHome = useAppStore((s) => s.createHome)
  const [editing, setEditing] = useState<EditingField>(null)
  const [renameError, setRenameError] = useState<string | null>(null)

  const menuItems: MenuItem[] = home.listed
    ? [
        { label: '重命名', onSelect: () => setEditing('name') },
        { label: '编辑说明', onSelect: () => setEditing('description') },
        {
          label: '从清单移除',
          danger: true,
          onSelect: () => {
            // 菜单已关闭，再在条目位置弹出确认菜单；只动清单，不删文件。
            const rect = document
              .querySelector(`[data-pi-home-id="${home.id}"]`)
              ?.getBoundingClientRect()
            openMenu(
              rect?.left ?? 0,
              (rect?.bottom ?? 0) + 4,
              [
                { label: '移除', danger: true, onSelect: () => void removeHome(home.id) },
                { label: '取消', onSelect: () => {} },
              ],
              `移除「${home.name}」？仅从清单移除，不动文件。`,
            )
          },
        },
      ]
    : [{ label: '登记到清单', onSelect: () => void createHome({ mode: 'adopt', path: home.path }) }]

  if (editing) {
    const isName = editing === 'name'
    return (
      <li className="preset-item preset-item-editing">
        <InlineInput
          initial={isName ? home.name : (home.description ?? '')}
          placeholder={isName ? 'agent 名（同一清单内唯一）' : '一句话说明（可留空清除）'}
          onDone={(value) => {
            setEditing(null)
            setRenameError(null)
            const text = value.trim()
            const report = (failure: string | null) => {
              if (failure) setRenameError(failure)
            }
            if (isName) {
              if (text && text !== home.name) void updateHome(home.id, { name: text }).then(report)
            } else if (text !== (home.description ?? '')) {
              void updateHome(home.id, { description: text }).then(report)
            }
          }}
        />
      </li>
    )
  }

  return (
    <li
      data-pi-home-id={home.id}
      className={`preset-item${active ? ' active' : ''}${home.valid ? '' : ' invalid'}`}
      title={`${home.name}\n${home.path}${home.description ? `\n${home.description}` : ''}\n右键查看更多操作`}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY, menuItems, home.description || undefined)
      }}
    >
      {renameError ? <span className="preset-error">{renameError}</span> : null}
      <span className="preset-main">
        <span className="preset-name">
          {home.name}
          <span className="preset-source">{home.sources.map((s) => SOURCE_LABEL[s]).join('/')}</span>
        </span>
        <span className="preset-path">{home.path}</span>
        <span className="preset-sub">{summaryLine(home)}</span>
      </span>
    </li>
  )
}

/** 新增 pi home 的面板：模式（初始化/复制/登记）+ 路径 + 名称 + 复制来源。 */
function CreatePanel({ onDone }: { onDone: () => void }) {
  const homes = useAppStore((s) => s.homes)
  const homePath = useAppStore((s) => s.homePath)
  const createHome = useAppStore((s) => s.createHome)
  const [mode, setMode] = useState<HomeCreateMode>('init')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [from, setFrom] = useState(homePath)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const sources = homes.filter((h) => h.valid && h.path !== path.trim())

  const listDir = useCallback<ListDirFn>(
    (target) =>
      api.browseDirs(target).then((dto) => ({
        location: parse(dto.path),
        parent: dto.parent ? parse(dto.parent) : null,
        entries: dto.entries,
      })),
    [],
  )

  async function submit() {
    const target = path.trim()
    if (!target) {
      setError('请输入路径')
      return
    }
    setBusy(true)
    setError(null)
    const failure = await createHome({
      mode,
      path: target,
      name: name.trim() || undefined,
      from: mode === 'clone' ? from : undefined,
    })
    setBusy(false)
    if (failure) {
      setError(failure)
      return
    }
    onDone()
  }

  return (
    <div className="preset-create">
      <div className="preset-create-modes" role="group" aria-label="新增方式">
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`preset-mode${mode === option.value ? ' active' : ''}`}
            aria-pressed={mode === option.value}
            title={option.hint}
            onClick={() => setMode(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="preset-create-path">
        <input
          className="preset-inline-input"
          value={path}
          placeholder={mode === 'adopt' ? '已有 pi home 的绝对路径' : '新目录绝对路径，如 ~/.pi/work'}
          aria-label="pi home 路径"
          onChange={(e) => {
            setPath(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') onDone()
          }}
        />
        <button
          type="button"
          className="preset-create-browse"
          aria-expanded={browsing}
          onClick={() => setBrowsing((current) => !current)}
        >
          {browsing ? '收起浏览' : '浏览目录…'}
        </button>
      </div>
      {browsing ? (
        <DirBrowser
          listDir={listDir}
          initialPath={path.trim() || '~'}
          onSelect={(uri) => {
            setPath(parse(uri).path)
            setBrowsing(false)
            setError(null)
          }}
          onCancel={() => setBrowsing(false)}
          selectLabel="用这个目录"
          placeholder="路径回车跳转，文字过滤"
        />
      ) : null}
      <input
        className="preset-inline-input"
        value={name}
        placeholder="显示名称（留空取目录名）"
        aria-label="显示名称"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') onDone()
        }}
      />
      {mode === 'clone' ? (
        <select className="preset-inline-input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="复制来源">
          {sources.map((h) => (
            <option key={h.id} value={h.path}>
              {h.name}（{h.path}）
            </option>
          ))}
        </select>
      ) : null}
      <div className={`preset-add-hint${error ? ' error' : ''}`}>
        {error ??
          (mode === 'init'
            ? '目录不存在或为空时创建；生成 settings.json 与空的 skills/、agents/'
            : mode === 'clone'
              ? '复制 settings/models/mcp 与 skills/agents/prompts/themes；不含 auth.json 凭据'
              : '目录必须已是 pi home（含 settings.json）')}
      </div>
      <div className="preset-create-actions">
        <button type="button" className="btn small" disabled={busy} onClick={() => void submit()}>
          {busy ? '处理中…' : MODE_OPTIONS.find((o) => o.value === mode)?.label}
        </button>
        <button type="button" className="btn small" onClick={onDone} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  )
}

/** pi home 清单：点一行切换，右键重命名/移除，「+」展开新增面板。 */
export function HomeList() {
  const homes = useAppStore((s) => s.homes)
  const homesLoading = useAppStore((s) => s.homesLoading)
  const homePath = useAppStore((s) => s.homePath)
  const confirmHome = useAppStore((s) => s.confirmHome)
  const refreshHomes = useAppStore((s) => s.refreshHomes)
  const [creating, setCreating] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const openMenu: OpenMenu = (x, y, items, heading) => setMenu({ x, y, items, heading })

  return (
    <nav className="config-sidebar config-sidebar-homes" aria-label="pi home">
      <div className="config-sidebar-head">
        <span
          className="config-sidebar-heading"
          title="每份 pi home 就是一个 agent：自带模型、凭据、skills 与 agents，这份清单也是 agent 清单"
        >
          Pi home
        </span>
        <button
          type="button"
          className="rail-toggle"
          title="重新扫描"
          onClick={() => void refreshHomes()}
        >
          ↻
        </button>
        <button
          type="button"
          className="rail-toggle"
          title="新增 pi home"
          aria-expanded={creating}
          onClick={() => setCreating((prev) => !prev)}
        >
          +
        </button>
      </div>

      {creating ? <CreatePanel onDone={() => setCreating(false)} /> : null}

      <ul className="preset-list">
        {homes.map((home) => (
          <HomeItem
            key={home.id}
            home={home}
            active={home.path === homePath}
            onSelect={() => void confirmHome(home.path)}
            openMenu={openMenu}
          />
        ))}
        {homes.length === 0 ? (
          <li className="preset-empty">{homesLoading ? '扫描中…' : '没有发现 pi home'}</li>
        ) : null}
      </ul>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </nav>
  )
}

/** 配置的六个分区。 */
export function SectionList({
  active,
  onSelect,
}: {
  active: SectionId
  onSelect: (id: SectionId) => void
}) {
  return (
    <nav className="config-sidebar config-sidebar-sections" aria-label="配置分区">
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          className="sidebar-item"
          aria-current={section.id === active}
          onClick={() => onSelect(section.id)}
        >
          <span className="sidebar-item-icon" aria-hidden>
            {section.icon}
          </span>
          <span className="sidebar-item-label">{section.label}</span>
        </button>
      ))}
    </nav>
  )
}
