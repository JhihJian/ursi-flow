import { useCallback, useState } from 'react'
import { useResource } from '@/shared/hooks/use-resource'
import { useUnsavedChanges } from '@/shared/hooks/use-unsaved-changes'
import type { Directory, Entry } from '@/modules/directories/api'
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
  const [tab, setTab] = useState<ConfigTab>('prompt')
  const [promptDirty, setPromptDirty] = useState(false)
  const [skillDirty, setSkillDirty] = useState(false)
  const [mcpDirty, setMcpDirty] = useState(false)
  const tree = useResource<Entry[]>(signal => directory.tree(signal), [])

  // 切换配置包是路由跳转，未保存的提示词或 MCP 草稿要先确认。
  const isDirty = useCallback(() => promptDirty || mcpDirty || skillDirty, [promptDirty, mcpDirty, skillDirty])
  useUnsavedChanges(isDirty)

  const tabs = [
    { id: 'prompt' as const, label: '系统提示词' },
    { id: 'skills' as const, label: 'Skills', count: skillNames(tree.data).length },
    { id: 'mcp' as const, label: 'MCP' },
  ]

  // 三个分区全部挂载，只用可见性切换：切走再切回时未保存的草稿还在。
  return <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
    <ConfigTabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="配置补丁分区" />
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
      <Mcp directory={directory} onDirtyChange={setMcpDirty} />
    </div>
  </div>
}
