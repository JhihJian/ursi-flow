import { useMemo, useState } from 'react'
import { deleteDnsCacheEntry } from '@/api/client'
import { formatClock, formatExpiry } from '@/lib/format'
import { cx, errorMessage } from '@/lib/ui'
import { useDaeStore } from '@/store/dae-store'

type Tab = 'log' | 'cache'

/** 缓存条目可能带整组地址，列表只留前四条。 */
function answerSummary(answers: Array<{ data: string }>): string {
  if (answers.length === 0) return '-'
  const head = answers.slice(0, 4).map((answer) => answer.data).join('  ')
  return answers.length > 4 ? `${head} …+${answers.length - 4}` : head
}

export function DnsSection() {
  const dnsLog = useDaeStore((state) => state.dnsLog)
  const dnsCache = useDaeStore((state) => state.dnsCache)
  const dnsLogTotal = useDaeStore((state) => state.dnsLogTotal)
  const dnsCacheTotal = useDaeStore((state) => state.dnsCacheTotal)
  const refresh = useDaeStore((state) => state.refresh)
  const flushCache = useDaeStore((state) => state.flushCache)
  const [tab, setTab] = useState<Tab>('log')
  const [needle, setNeedle] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const normalized = needle.trim().toLowerCase()
  const logRows = useMemo(
    () => dnsLog.filter((record) => !normalized || record.question.name.toLowerCase().includes(normalized)),
    [dnsLog, normalized],
  )
  const cacheRows = useMemo(
    () => dnsCache.filter((entry) => !normalized || entry.domain.toLowerCase().includes(normalized)),
    [dnsCache, normalized],
  )

  const handleFlush = async () => {
    if (!window.confirm('清空 dae 的全部 DNS 缓存？')) return
    setActionError(null)
    try {
      await flushCache()
    } catch (error) {
      setActionError(errorMessage(error))
    }
  }

  const handleDelete = async (entryId: string) => {
    setActionError(null)
    try {
      await deleteDnsCacheEntry(entryId)
      await refresh()
    } catch (error) {
      setActionError(errorMessage(error))
    }
  }

  return (
    <div className="dns">
      <div className="toolbar">
        <div className="status-targets">
          <button
            type="button"
            className={cx('status-target', tab === 'log' && 'is-active')}
            onClick={() => setTab('log')}
          >
            解析日志 <span className="status-count">{dnsLogTotal}</span>
          </button>
          <button
            type="button"
            className={cx('status-target', tab === 'cache' && 'is-active')}
            onClick={() => setTab('cache')}
          >
            缓存 <span className="status-count">{dnsCacheTotal}</span>
          </button>
        </div>
        <input
          className="filter-input"
          placeholder="过滤域名"
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
        />
        {tab === 'cache' ? (
          <button type="button" className="btn btn-sm" onClick={() => void handleFlush()}>
            清空缓存
          </button>
        ) : null}
      </div>
      {actionError ? <p className="section-error">{actionError}</p> : null}

      {tab === 'log' ? (
        logRows.length === 0 ? (
          <p className="empty-state">没有解析记录。</p>
        ) : (
          <table className="data-table dns-table">
            <thead>
              <tr>
                <th className="col-time">时间</th>
                <th>域名</th>
                <th className="col-kind">类型</th>
                <th className="col-state">状态</th>
                <th className="col-outbound">来源</th>
                <th className="col-num">耗时</th>
                <th>应答</th>
              </tr>
            </thead>
            <tbody>
              {logRows.map((record) => (
                <tr key={record.id}>
                  <td className="col-time">{formatClock(record.observed_at)}</td>
                  <td className="rule-expression">{record.question.name}</td>
                  <td className="col-kind dim">{record.question.type}</td>
                  <td className={cx('col-state', record.status === 'NOERROR' ? 'is-ok' : 'danger')}>
                    {record.status}
                  </td>
                  <td className="col-outbound">
                    <span>{record.cached ? '缓存' : (record.upstream ?? '上游')}</span>
                    <span className="proc-meta">{record.route.source}</span>
                  </td>
                  <td className="col-num dim">{record.elapsed_ms}ms</td>
                  <td className="dns-answers">
                    {record.answers.length === 0
                      ? '-'
                      : record.answers
                          .slice(0, 3)
                          .map((answer) => answer.data)
                          .join('  ')}
                    {record.answers.length > 3 ? ` …+${record.answers.length - 3}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : cacheRows.length === 0 ? (
        <p className="empty-state">缓存为空。</p>
      ) : (
        <table className="data-table dns-table">
          <thead>
            <tr>
              <th>域名</th>
              <th className="col-kind">类型</th>
              <th className="col-state">状态</th>
              <th className="col-time">过期</th>
              <th>应答</th>
              <th className="col-tool" />
            </tr>
          </thead>
          <tbody>
            {cacheRows.map((entry) => (
              <tr key={entry.entry_id}>
                <td className="rule-expression">{entry.domain}</td>
                <td className="col-kind dim">{entry.type}</td>
                <td className={cx('col-state', entry.status === 'positive' ? 'is-ok' : 'dim')}>
                  {entry.status}
                </td>
                <td className="col-time dim">{formatExpiry(entry.expires_at)}</td>
                <td className="dns-answers">{answerSummary(entry.answers ?? [])}</td>
                <td className="col-tool">
                  <button
                    type="button"
                    className="row-tool"
                    title="删除该缓存"
                    onClick={() => void handleDelete(entry.entry_id)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
