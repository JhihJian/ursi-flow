import { useCallback, useState } from 'react'
import { useResource } from '@/shared/hooks/use-resource'
import { useUnsavedChanges } from '@/shared/hooks/use-unsaved-changes'
import type { Directory, Entry } from '@/modules/directories/api'
import { Explorer } from './Explorer'
import { ConfigTabs } from './config/ConfigTabs'
import { Mcp } from './config/Mcp'
import { skillNames, type ConfigTab } from './config/model'
import { Skills } from './config/Skills'
import { SystemPrompt } from './config/SystemPrompt'

/**
 * 配置补丁编辑器：三个锚点各自一页，标签保持紧凑，切换时保留未保存的草稿。
 * 包标识由父组件通过 key 固定，这里只处理一个补丁的文件。
 */
export function ConfigEditor({ directory }: { directory: Directory }) {
  const [tab, setTab] = useState<ConfigTab>('overview')
  const [overviewDirty, setOverviewDirty] = useState(false)
  const [promptDirty, setPromptDirty] = useState(false)
  const [skillDirty, setSkillDirty] = useState(false)
  const [mcpDirty, setMcpDirty] = useState(false)
  const tree = useResource<Entry[]>(signal => directory.tree(signal), [])

  const isDirty = useCallback(() => overviewDirty || promptDirty || mcpDirty || skillDirty, [overviewDirty, promptDirty, mcpDirty, skillDirty])
  const { canLeave } = useUnsavedChanges(isDirty)

  async function selectTab(next: ConfigTab) {
    if (next === tab) return
    // 总览与专用视图编辑的是同一份文件，切换时重新挂载以读取最新内容。
    if (tab === 'overview' || next === 'overview') {
      if (!await canLeave()) return
      setOverviewDirty(false)
      setPromptDirty(false)
      setSkillDirty(false)
      setMcpDirty(false)
      tree.reload()
    }
    setTab(next)
  }

  const tabs = [
    { id: 'overview' as const, label: '总览' },
    { id: 'prompt' as const, label: '系统提示词' },
    { id: 'skills' as const, label: 'Skills', count: skillNames(tree.data).length },
    { id: 'mcp' as const, label: 'MCP' },
  ]

  // 专用视图之间切换时保留草稿。
  return <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
    <ConfigTabs tabs={tabs} value={tab} onChange={selectTab} ariaLabel="配置补丁分区" />
    {tab === 'overview' ? <Explorer directory={directory} onDirtyChange={setOverviewDirty} /> : <>
    <div aria-hidden={tab !== 'prompt'} className={tab === 'prompt' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <SystemPrompt directory={directory} onDirtyChange={setPromptDirty} />
    </div>
    <div aria-hidden={tab !== 'skills'} className={tab === 'skills' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <Skills
        directory={directory}
        dirty={skillDirty}
        onDirtyChange={setSkillDirty}
        entries={tree.data}
        loading={tree.loading}
        error={tree.error}
        onReload={tree.reload}
      />
    </div>
    <div aria-hidden={tab !== 'mcp'} className={tab === 'mcp' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <Mcp active={tab === 'mcp'} directory={directory} onDirtyChange={setMcpDirty} />
    </div>
    </>}
  </div>
}
