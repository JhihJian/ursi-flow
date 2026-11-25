import { useEffect, useRef, useState } from 'react'
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
  const draft = useDaeStore((state) => state.configDraft)
  const dirty = useDaeStore((state) => state.configDirty)
  const diagnostics = useDaeStore((state) => state.configDiagnostics)
  const notice = useDaeStore((state) => state.configNotice)
  const busy = useDaeStore((state) => state.configBusy)
  const loadConfig = useDaeStore((state) => state.loadConfig)
  const setDraft = useDaeStore((state) => state.setConfigDraft)
  const resetDraft = useDaeStore((state) => state.resetConfigDraft)
  const checkDraft = useDaeStore((state) => state.checkDraft)
  const saveDraft = useDaeStore((state) => state.saveDraft)
  const revertToBackup = useDaeStore((state) => state.revertToBackup)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)
  const [backupChoice, setBackupChoice] = useState('')

  useEffect(() => {
    if (!config) void loadConfig()
  }, [config, loadConfig])

  const syncScroll = () => {
    const textarea = textareaRef.current
    const gutter = gutterRef.current
    if (!textarea || !gutter) return
    gutter.scrollTop = textarea.scrollTop
  }

  const handleSave = async () => {
    if (!window.confirm('校验通过后会写入配置文件并热加载 dae。继续？')) return
    await saveDraft(draft)
  }

  const handleRevert = async () => {
    if (!backupChoice) return
    if (!window.confirm(`用备份 ${backupChoice} 覆盖当前配置并热加载？`)) return
    await revertToBackup(backupChoice)
  }

  if (!config) {
    return (
      <p className="empty-state">
        {notice?.message ?? '正在读取 dae 配置文件…'}
      </p>
    )
  }

  return (
    <div className="config">
      <div className="toolbar">
        <span className="config-path">{config.file}</span>
        <span className={cx('config-flag', config.canWrite ? 'is-ok' : 'is-warn')}>
          {config.canWrite ? '可写' : `只读：${config.writeReason ?? '未知原因'}`}
        </span>
        <span className="config-flag">
          {config.apiWritable
            ? 'dae config_write 已启用'
            : `dae API 未开放写配置（${config.apiReason ?? 'writes_disabled'}）`}
        </span>
        {dirty ? <span className="config-dirty">未保存</span> : null}
        <div className="config-actions">
          <button type="button" className="btn btn-sm" onClick={() => void checkDraft()} disabled={busy}>
            校验
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleSave()}
            disabled={busy || !dirty || !config.canWrite}
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
          <h3 className="block-title">备份</h3>
          <span className="block-meta">保存前自动备份，保留最近 20 份</span>
        </div>
        {config.backups.length === 0 ? (
          <p className="empty-state">还没有备份。第一次保存时会生成。</p>
        ) : (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  <th>文件</th>
                  <th className="col-num">大小</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {config.backups.map((backup) => (
                  <tr key={backup.name}>
                    <td>{backup.name}</td>
                    <td className="col-num">{formatBytes(backup.bytes)}</td>
                    <td className="dim">{formatDateTime(backup.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="toolbar config-restore">
              <select
                className="control-select"
                value={backupChoice}
                onChange={(event) => setBackupChoice(event.target.value)}
              >
                <option value="">选择要回滚的备份</option>
                {config.backups.map((backup) => (
                  <option key={backup.name} value={backup.name}>
                    {backup.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => void handleRevert()}
                disabled={busy || !backupChoice}
              >
                回滚并热加载
              </button>
            </div>
          </>
        )}
      </div>

      <p className="footnote">
        保存流程：dae 的 full 校验 → 备份当前文件 → 以 sudo 写入 {config.file} → 触发热加载。
        热加载失败会自动写回备份并再次加载。dae 自带的写配置接口要求同时开启 api.config_write 与
        api.secret，设了 secret 后整个 API 都要 Bearer token，因此这里改用本机 sudo 落盘，不改 dae 的认证模型。
      </p>
    </div>
  )
}
