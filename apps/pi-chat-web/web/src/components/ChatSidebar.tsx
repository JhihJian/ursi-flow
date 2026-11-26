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
 * 对话侧栏：pi home（整套配置）、新对话的工作目录与 subagent、本模块打开的对话。
 *
 * 模型与思考级别属于「这场对话」，放在工作区的输入区上，跟 pi-web 的 composer
 * 一致；侧栏只决定新对话落在哪儿。历史会话不在这一栏，它在会话模块里。
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
    startNewChat,
    draft,
    setDraft,
    sending,
    close,
  } = useChatController()

  const current = homes.find((entry) => entry.path === home)
  const validHomes = homes.filter((entry) => entry.valid)
  const running = chats.filter((chat) => chat.state === 'running').length

  return (
    <div className="pichat pichat-sidebar-host">
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
            title="重新读取该 home 的对话可选项"
            aria-label="重新读取对话可选项"
            onClick={() => void refreshOptions()}
          >
            ↻
          </button>
        }
      >
        <div className="pichat-body">
          <label className="pichat-field">
            <span className="pichat-label">pi home（整套配置）</span>
            <select
              className="pichat-select"
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
            <p className="pichat-note" title={home}>
              {home}
            </p>
          ) : (
            <p className="pichat-hint">在管理台新增 pi home 后这里才能选。</p>
          )}

          <div className="pichat-section-head">
            <span className="pichat-section">新对话</span>
          </div>

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
              className="pichat-select"
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
          <p className="pichat-hint">
            模型与思考级别在输入区选。发出第一条消息时才建会话，对话直接落在该 home 的 sessions/ 里。
          </p>

          <button
            type="button"
            className="pichat-button is-block"
            disabled={sending || !home}
            onClick={startNewChat}
          >
            开始新对话
          </button>

          {optionsError ? <p className="pichat-error">{optionsError}</p> : null}
          {options && options.models.length === 0 ? (
            <p className="pichat-hint">
              该 home 还没有采集到模型目录：先用默认模型，需要选择具体模型时去管理台的模型分区刷新。
            </p>
          ) : null}
          {options?.isScoped ? (
            <p className="pichat-hint">
              候选模型按该 home 的 enabledModels 限定（{options.models.length} 个）。
            </p>
          ) : null}
          {(options?.scopeWarnings ?? []).map((warning) => (
            <p key={warning} className="pichat-hint">
              {warning}
            </p>
          ))}

          <div className="pichat-section-head">
            <span className="pichat-section">对话</span>
            <span className="pichat-count">{chats.length}</span>
          </div>

          <ul className="pichat-list">
            {chats.map((chat) => (
              <li key={chat.sessionId}>
                <button
                  type="button"
                  className={`pichat-item${chat.sessionId === activeId ? ' is-active' : ''}`}
                  title={`${chat.sessionId}\n${chat.home}\n${chat.sessionFile ?? '（尚未写入会话文件）'}`}
                  onClick={() => selectChat(chat.sessionId)}
                >
                  <span className="pichat-item-head">
                    <span className="pichat-item-name">{chat.name ?? chat.sessionId.slice(0, 12)}</span>
                    <span className={`pichat-item-state is-${chat.state}`}>
                      {STATUS_TEXT[chat.state] ?? chat.state}
                    </span>
                  </span>
                  <span className="pichat-item-meta">
                    <span className="pichat-item-model">
                      {chat.model ?? '默认模型'} · {chat.thinkingLevel ?? '—'}
                    </span>
                    <span>{formatAge(chat.updatedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
            {chats.length === 0 ? <li className="pichat-note">还没有打开的对话</li> : null}
          </ul>

          {activeId ? (
            <button type="button" className="pichat-link" onClick={() => void close()}>
              结束当前对话
            </button>
          ) : null}
        </div>
      </SidebarFrame>
    </div>
  )
}
