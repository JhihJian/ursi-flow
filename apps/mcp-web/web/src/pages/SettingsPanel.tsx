import { useState } from 'react'
import type { McpSettings, McpServer } from '../client'
import { useMcp } from '../context'
import { useMutation } from '../lib/use-mutation'
import { Switch } from '../ui/switch'
import { DataTable } from '../ui/data-table'
import { Input } from '../ui/input'
import { Button } from '../ui/button'

export type SettingsProps = { server: McpServer; settings: McpSettings; saved: (s: McpSettings) => void }
// Provider catalog, not a capability returned by MCP server/discover.
const known = 'actions code_quality code_security copilot copilot_automations copilot_issue_intents dependabot discussions gists git governance issues labels notifications orgs projects pull_requests repos secret_protection security_advisories stargazers users copilot_spaces github_support_docs_search'.split(' ')
export function SettingsPanel({ server, settings, saved }: SettingsProps) {
  const { client } = useMcp()
  const mutation = useMutation()
  const [filter, setFilter] = useState('')
  const [custom, setCustom] = useState('')
  function update(patch: Partial<McpSettings>) { void mutation.run(signal => client.saveSettings(server.id, { ...settings, ...patch }, signal), saved) }
  const sets = settings.githubToolsets
  const ids = [...new Set([...known, ...sets])].filter(id => id.includes(filter.trim().toLowerCase()))
  return <div className="grid min-w-0 content-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    {mutation.error && <p role="alert" className="border border-err/40 bg-err/10 p-3 text-sm text-err xl:col-span-2">{mutation.error}</p>}
    <section aria-label="GitHub 工具集" className="panel grid min-w-0 content-start gap-3 p-4">
      <div className="border-b border-line pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">GitHub 工具集</h2>
          <label className="flex items-center gap-2 text-xs text-txt2">只读模式<Switch checked={settings.githubReadOnly} disabled={mutation.busy} onCheckedChange={githubReadOnly => update({ githubReadOnly })} /></label>
        </div>
        <p role="status" className="mt-1 text-xs text-txt3">{sets.length ? `已显式选择 ${sets.length} 个工具集` : '使用 GitHub 默认工具集'}</p>
      </div>
      <Input aria-label="筛选工具集" placeholder="筛选工具集" value={filter} onChange={e => setFilter(e.target.value)} />
      {ids.length ? <DataTable key={filter} label="GitHub 工具集" data={ids} rowId={id => id} columns={[
        { id: 'id', header: '工具集标识', cell: ({ row }) => row.original },
        { id: 'enabled', header: '显式启用', cell: ({ row }) => <Switch aria-label={`启用工具集 ${row.original}`} checked={sets.includes(row.original)} disabled={mutation.busy} onCheckedChange={on => update({ githubToolsets: on ? [...sets, row.original] : sets.filter(id => id !== row.original) })} /> },
      ]} /> : <p className="text-sm text-txt3">没有匹配的工具集</p>}
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); update({ githubToolsets: [...sets, custom] }) }}><Input aria-label="自定义工具集标识" placeholder="自定义工具集标识" value={custom} onChange={e => setCustom(e.target.value.trim())} /><Button type="submit" disabled={mutation.busy || !/^[a-z0-9_]{1,64}$/.test(custom) || sets.includes(custom)}>启用</Button></form>
    </section>
    <section aria-label="已授权工具" className="panel grid min-w-0 content-start gap-3 p-4">
      <h2 className="border-b border-line pb-3 text-sm font-semibold">已授权工具<span className="ml-1.5 text-xs font-normal text-txt3">{settings.allowedTools.length} 个</span></h2>
      {settings.allowedTools.length ? <DataTable label="本地工具授权" data={settings.allowedTools} rowId={id => id} columns={[
        { id: 'name', header: '工具名称', cell: ({ row }) => <span className="block max-w-56 truncate font-mono text-xs" title={row.original}>{row.original}</span> },
        { id: 'allowed', header: '允许调用', cell: ({ row }) => <Switch aria-label={`允许调用 ${row.original}`} checked disabled={mutation.busy} onCheckedChange={() => update({ allowedTools: settings.allowedTools.filter(id => id !== row.original) })} /> },
      ]} /> : <p className="text-sm text-txt3">暂无本地调用授权</p>}
    </section>
  </div>
}
