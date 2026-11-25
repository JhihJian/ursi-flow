import { useState } from 'react'
import { cx } from '@/lib/ui'
import { useDaeStore } from '@/store/dae-store'

type Tab = 'traffic' | 'request' | 'response'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'traffic', label: '流量规则' },
  { id: 'request', label: 'DNS 请求' },
  { id: 'response', label: 'DNS 响应' },
]

export function RulesSection() {
  const rules = useDaeStore((state) => state.rules)
  const ruleGeneration = useDaeStore((state) => state.ruleGeneration)
  const dnsRules = useDaeStore((state) => state.dnsRules)
  const [tab, setTab] = useState<Tab>('traffic')

  const dnsRuleRows = tab === 'request' ? (dnsRules?.request ?? []) : (dnsRules?.response ?? [])

  return (
    <div className="rules">
      <div className="toolbar">
        <div className="status-targets">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cx('status-target', tab === item.id && 'is-active')}
              onClick={() => setTab(item.id)}
            >
              {item.label}{' '}
              <span className="status-count">
                {item.id === 'traffic'
                  ? rules.length
                  : item.id === 'request'
                    ? dnsRules?.request.length ?? 0
                    : dnsRules?.response.length ?? 0}
              </span>
            </button>
          ))}
        </div>
        <span className="toolbar-meta">generation {ruleGeneration ?? dnsRules?.generation_id ?? '-'}</span>
      </div>

      {tab === 'traffic' ? (
        rules.length === 0 ? (
          <p className="empty-state">没有可读的流量规则。</p>
        ) : (
          <table className="data-table rule-table">
            <thead>
              <tr>
                <th className="col-rule-id">规则</th>
                <th>表达式</th>
                <th className="col-outbound">出口</th>
                <th className="col-kind">类型</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.rule_id}>
                  <td className="col-rule-id dim">{rule.rule_id}</td>
                  <td className="rule-expression">{rule.expression}</td>
                  <td className="col-outbound">{rule.outbound}</td>
                  <td className="col-kind dim">{rule.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : dnsRuleRows.length === 0 ? (
        <p className="empty-state">没有可读的 DNS 规则。</p>
      ) : (
        <table className="data-table rule-table">
          <thead>
            <tr>
              <th className="col-rule-id">规则</th>
              <th>表达式</th>
              <th className="col-outbound">动作</th>
              <th className="col-outbound">上游</th>
              <th className="col-kind">类型</th>
            </tr>
          </thead>
          <tbody>
            {dnsRuleRows.map((rule) => (
              <tr key={rule.rule_id}>
                <td className="col-rule-id dim">{rule.rule_id}</td>
                <td className="rule-expression">{rule.expression}</td>
                <td className="col-outbound">{rule.action}</td>
                <td className="col-outbound dim">{rule.upstream ?? '-'}</td>
                <td className="col-kind dim">{rule.kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="footnote">
        首个命中的流量规则决定出口；规则改动只影响新连接，已有连接按建立时的决定转发。
      </p>
    </div>
  )
}
