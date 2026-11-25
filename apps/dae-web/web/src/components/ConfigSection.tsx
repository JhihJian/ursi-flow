import { useEffect, useRef } from 'react'
import { formatBytes, formatDateTime } from '@/lib/format'
import { cx } from '@/lib/ui'
import { useDaeStore } from '@/store/dae-store'

/** 编辑器行号与文本同高：行数按换行统计，滚动由外层统一处理。 */
function lineNumbers(text: string): string {
  const count = text.split('\n').length
  return Array.from({ length: count }, (_, index) => String(index + 1)).join('\n')
}

export function ConfigSection() {
  const config = useDaeStore((state) => state.config)
  const sourcePath = useDaeStore((state) => state.configSourcePath)
  const draft = useDaeStore((state) => state.configDraft)
  const dirty = useDaeStore((state) => state.configDirty)
  const diagnostics = useDaeStore((state) => state.configDiagnostics)
  const notice = useDaeStore((state) => state.configNotice)
  const busy = useDaeStore((state) => state.configBusy)
  const loadConfig = useDaeStore((state) => state.loadConfig)
  const selectSource = useDaeStore((state) => state.selectConfigSource)
  const setDraft = useDaeStore((state) => state.setConfigDraft)
  const resetDraft = useDaeStore((state) => state.resetConfigDraft)
  const checkDraft = useDaeStore((state) => state.checkDraft)
  const saveDraft = useDaeStore((state) => state.saveDraft)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!config) void loadConfig()
  }, [config, loadConfig])

  const syncScroll = () => {
    const textarea = textareaRef.current
    const gutter = gutterRef.current
    if (!textarea || !gutter) return
    gutter.scrollTop = textarea.scrollTop
  }

  const source = config?.sources.find((item) => item.path === sourcePath) ?? null

  const handleSave = async () => {
    if (!window.confirm(`校验通过后写入 ${sourcePath} 并热加载 dae。继续？`)) return
    await saveDraft()
  }

  if (!config) {
    return <p className="empty-state">{notice?.message ?? '正在读取 dae 配置…'}</p>
  }

  return (
    <div className="config">
      <div className="toolbar">
        <select
          className="control-select"
          value={sourcePath ?? ''}
          onChange={(event) => selectSource(event.target.value)}
        >
          {config.sources.map((item) => (
            <option key={item.path} value={item.path}>
              {item.path}
              {item.writable ? '' : '（只读）'}
            </option>
          ))}
        </select>
        <span className={cx('config-flag', config.writable ? 'is-ok' : 'is-warn')}>
          {config.writable ? 'dae 允许写配置' : `dae 不允许写配置：${config.layout_reason || '未知原因'}`}
        </span>
        <span className="config-flag">layout {config.layout}</span>
        {source && !source.writable ? (
          <span className="config-flag is-warn">该文件只读：{source.read_only_reason ?? '未知原因'}</span>
        ) : null}
        {dirty ? <span className="config-dirty">未保存</span> : null}
        <div className="config-actions">
          <button type="button" className="btn btn-sm" onClick={() => void checkDraft()} disabled={busy}>
            校验
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleSave()}
            disabled={busy || !dirty || !source?.writable}
          >
            保存并热加载
          </button>
          <button type="button" className="btn btn-sm" onClick={resetDraft} disabled={busy || !dirty}>
            撤销改动
          </button>
        </div>
      </div>

      {notice ? (
        <p className={cx('config-notice', notice.kind === 'ok' ? 'is-ok' : 'is-warn')}>{notice.message}</p>
      ) : null}

      <div className="config-editor">
        <pre className="config-gutter" ref={gutterRef} aria-hidden>
          {lineNumbers(draft)}
        </pre>
        <textarea
          ref={textareaRef}
          className="config-text"
          value={draft}
          spellCheck={false}
          readOnly={!source?.writable}
          onChange={(event) => setDraft(event.target.value)}
          onScroll={syncScroll}
        />
      </div>

      {diagnostics.length > 0 ? (
        <ul className="config-diagnostics">
          {diagnostics.map((item, index) => (
            <li key={`${item.code}-${index}`} className={cx('config-diagnostic', `level-${item.level}`)}>
              <span className="config-diagnostic-where">
                {item.line === null ? '-' : `${item.line}:${item.column ?? 1}`}
              </span>
              <span className="config-diagnostic-message">{item.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="config-backups">
        <div className="block-head">
          <h3 className="block-title">配置源</h3>
          <span className="block-meta">generation {config.generation_id}</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>文件</th>
              <th>类型</th>
              <th className="col-num">行数</th>
              <th className="col-num">大小</th>
              <th>加载时间</th>
              <th>写权限</th>
            </tr>
          </thead>
          <tbody>
            {config.sources.map((item) => (
              <tr
                key={item.path}
                className={cx(item.path === sourcePath && 'is-selected')}
                onClick={() => selectSource(item.path)}
              >
                <td>{item.path}</td>
                <td className="dim">{item.kind}</td>
                <td className="col-num">{item.line_count}</td>
                <td className="col-num">{formatBytes(item.bytes)}</td>
                <td className="dim">{formatDateTime(item.loaded_at)}</td>
                <td className={item.writable ? 'is-ok' : 'dim'}>
                  {item.writable ? '可写' : (item.read_only_reason ?? '只读')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="footnote">
        保存流程：dae 的 full 校验 → PUT /api/v1/config/sources/{source?.id ?? '{id}'} →
        dae 写文件、生成 .bak 并热加载，本服务等待操作到 succeeded。
        `config.dae` 是入口文件（`entry_source`），只含 include 块；`api.dae` 是隐藏源，改动需手动编辑并重启 dae。
      </p>
    </div>
  )
}
