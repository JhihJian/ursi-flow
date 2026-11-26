import { useMemo, useState } from 'react'
import { SidebarFrame, type ModuleSidebarProps } from '@ursi/workspace-shell'
import { useChatController } from '../chat-context'

function shortPath(path: string): string {
  if (!path) return '—'
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.slice(-2).join('/')
}

function formatAge(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

const STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  idle: '空闲',
  error: '出错',
}

/**
 * 对话侧栏：pi home（即整套配置）选择 + 新建对话的参数 + 本模块打开的对话列表。
 * 历史会话不在这一栏，它在会话模块里。
 */
export function ChatSidebar({ collapsed, collapse, expand }: ModuleSidebarProps) {
  const {
    homes,
    home,
    setHome,
    options,
    optionsError,
    refreshOptions,
    chats,
    activeId,
    selectChat,
    draft,
    setDraft,
    creating,
    createChat,
    close,
  } = useChatController()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const current = homes.find((entry) => entry.path === home)
  const validHomes = homes.filter((entry) => entry.valid)
  const running = chats.filter((chat) => chat.state === 'running').length

  const modelOptions = useMemo(() => options?.models ?? [], [options])

  return (
    <SidebarFrame
      title="Pi 对话"
      collapsed={collapsed}
      collapse={collapse}
      expand={expand}
      items={[
        { label: '运行', value: String(running) },
        { label: 'home', value: current?.name ?? '未选' },
      ]}
      actions={
        <button
          type="button"
          className="pichat-rail-toggle"
          title="重新读取该 home 的对话参数"
          onClick={() => void refreshOptions()}
        >
          ↻
        </button>
      }
    >
      <div className="pichat-sidebar">
        <label className="pichat-field">
          <span className="pichat-label">pi home（整套配置）</span>
          <select
            className="pichat-input"
            value={home}
            onChange={(event) => setHome(event.target.value)}
            title={home}
          >
            {validHomes.length === 0 ? <option value="">没有可用的 pi home</option> : null}
            {validHomes.map((entry) => (
              <option key={entry.id} value={entry.path}>
                {entry.name} · {shortPath(entry.path)}
              </option>
            ))}
          </select>
        </label>
        {home ? (
          <p className="pichat-hint" title={home}>
            {home}
          </p>
        ) : (
          <p className="pichat-hint">在管理台新增 pi home 后这里才能选。</p>
        )}

        <div className="pichat-sidebar-head">
          <span className="pichat-label">新对话</span>
          <button
            type="button"
            className="pichat-rail-toggle"
            aria-expanded={settingsOpen}
            title="展开新建对话的参数"
            onClick={() => setSettingsOpen((value) => !value)}
          >
            {settingsOpen ? '−' : '＋'}
          </button>
        </div>

        {settingsOpen ? (
          <div className="pichat-new">
            <label className="pichat-field">
              <span className="pichat-label">模型</span>
              <select
                className="pichat-input"
                value={draft.model}
                onChange={(event) => setDraft({ model: event.target.value })}
              >
                <option value="">该 home 的默认模型</option>
                {modelOptions.map((model) => (
                  <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                    {model.provider}/{model.id}
                    {model.enabled ? '' : '（未启用）'}
                  </option>
                ))}
              </select>
            </label>
            {modelOptions.length === 0 ? (
              <p className="pichat-hint">
                该 home 还没有采集到模型目录，先用默认模型；需要选择具体模型时去管理台的模型分区刷新。
              </p>
            ) : null}
            <label className="pichat-field">
              <span className="pichat-label">思考级别</span>
              <select
                className="pichat-input"
                value={draft.thinkingLevel}
                onChange={(event) => setDraft({ thinkingLevel: event.target.value })}
              >
                <option value="">该 home 的默认级别</option>
                {(options?.thinkingLevels ?? []).map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <label className="pichat-field">
              <span className="pichat-label">工作目录</span>
              <input
                className="pichat-input"
                value={draft.cwd}
                placeholder={options?.defaultCwd ?? '服务端当前目录'}
                onChange={(event) => setDraft({ cwd: event.target.value })}
              />
            </label>
            <label className="pichat-field">
              <span className="pichat-label">subagent</span>
              <select
                className="pichat-input"
                value={draft.subagent}
                onChange={(event) => setDraft({ subagent: event.target.value })}
              >
                <option value="">普通主会话</option>
                {(options?.agents ?? []).map((agent) => (
                  <option key={agent} value={agent}>
                    {agent}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <button
          type="button"
          className="pichat-primary"
          disabled={creating || !home}
          onClick={() => void createChat()}
        >
          {creating ? '创建中…' : '新建对话'}
        </button>

        {optionsError ? <p className="pichat-error">{optionsError}</p> : null}

        <div className="pichat-sidebar-head">
          <span className="pichat-label">对话</span>
          <span className="pichat-count">{chats.length}</span>
        </div>
        <ul className="pichat-list">
          {chats.map((chat) => (
            <li key={chat.sessionId}>
              <button
                type="button"
                className={`pichat-item${chat.sessionId === activeId ? ' is-active' : ''}`}
                title={`${chat.sessionId}\n${chat.sessionFile ?? '（尚未写入会话文件）'}`}
                onClick={() => selectChat(chat.sessionId)}
              >
                <span className={`pichat-dot is-${chat.state}`} aria-hidden />
                <span className="pichat-item-main">
                  <span className="pichat-item-name">{chat.name ?? chat.sessionId.slice(0, 12)}</span>
                  <span className="pichat-item-meta">
                    {chat.model ?? '默认模型'} · {shortPath(chat.home)} · {formatAge(chat.updatedAt)}
                  </span>
                </span>
                <span className="pichat-item-state">{STATUS_TEXT[chat.state] ?? chat.state}</span>
              </button>
            </li>
          ))}
          {chats.length === 0 ? <li className="pichat-empty-line">还没有打开的对话</li> : null}
        </ul>

        {activeId ? (
          <button type="button" className="pichat-link" onClick={() => void close()}>
            结束当前对话
          </button>
        ) : null}
      </div>
    </SidebarFrame>
  )
}
