import { useState } from 'react'
import { errorMessage } from '@/shared/api'
import { cn } from '@/shared/lib/utils'
import { confirmAction } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { ResourceState } from '@/shared/ui/resource-state'
import type { Directory, Entry } from '../api'
import { Explorer } from '../Explorer'
import { SKILLS_ROOT, skillEntryPath, skillNameError, skillNames, skillPath, skillTemplate } from './model'

export interface SkillsProps {
  directory: Directory
  dirty: boolean
  onDirtyChange: (dirty: boolean) => void
  entries: Entry[]
  loading: boolean
  error: unknown
  onReload: () => void
}

/**
 * Skills：列表来自 `skills/` 目录本身，新增 Skill 就是新建目录并写入 SKILL.md。
 * 选中后交给共享 Explorer 维护入口文件与附属文件。
 */
export function Skills({ directory, dirty, onDirtyChange, entries, loading, error, onReload }: SkillsProps) {
  const names = skillNames(entries)
  const [selected, setSelected] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [errorText, setErrorText] = useState('')
  const [busy, setBusy] = useState(false)

  async function allowSwitch() {
    return !dirty || await confirmAction({ title: '放弃未保存的技能更改？', description: '切换 Skill 后，当前文件的草稿将不会保存。', confirmLabel: '放弃更改', danger: true })
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const name = draftName.trim()
    const problem = skillNameError(name, names)
    if (problem) { setErrorText(problem); return }
    if (!await allowSwitch()) return
    setBusy(true)
    setErrorText('')
    let createdDir = false
    try {
      await directory.mkdir(skillPath(name))
      createdDir = true
      await directory.write(skillEntryPath(name), skillTemplate(name), false)
      setDraftName('')
      setSelected(name)
      onReload()
    } catch (cause) {
      // 另一个编辑器可能已写入该目录，不能用递归删除回滚。
      if (createdDir) { setSelected(name); onReload() }
      setErrorText(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return <div className="flex min-h-0 flex-1 flex-col gap-3 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
    <div className="flex min-h-0 min-w-0 shrink-0 flex-col gap-3 lg:h-full">
      <form className="flex min-w-0 flex-col gap-2" onSubmit={create}>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] text-txt3">新建 Skill 名称</span>
          <Input
            aria-label="新建 Skill 名称"
            className="h-8 text-[13px]"
            placeholder="code-review"
            value={draftName}
            onChange={event => { setDraftName(event.target.value); setErrorText('') }}
          />
        </label>
        <Button type="submit" size="sm" icon="plus" loading={busy} disabled={!draftName.trim()} data-testid="skill-create">新增 Skill</Button>
        {errorText ? <p role="alert" className="text-xs text-err">{errorText}</p> : null}
      </form>
      <div className="scroll-area max-h-56 min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-surface lg:max-h-none">
        {loading && !entries.length
          ? <p className="px-3 py-4 text-xs text-txt3">正在读取 {SKILLS_ROOT}/ …</p>
          : error
            ? <ResourceState error={error} onRetry={onReload} className="rounded-none border-0 shadow-none" />
            : names.length
              ? <ul className="divide-y divide-line">
                {names.map(name => <li key={name}>
                  <button
                    type="button"
                    aria-pressed={selected === name}
                    data-testid={`skill-item-${name}`}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors',
                      selected === name ? 'bg-accent-dim text-accent-2' : 'text-txt2 hover:bg-elevated hover:text-txt',
                    )}
                    onClick={async () => { if (selected !== name && await allowSwitch()) setSelected(name) }}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
                  </button>
                </li>)}
              </ul>
              : <p className="px-3 py-4 text-xs leading-6 text-txt3">{SKILLS_ROOT}/ 下还没有 Skill。新建后会创建目录和 SKILL.md。</p>}
      </div>
    </div>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-line bg-surface">
      {selected
        ? <Explorer
          key={selected}
          directory={directory}
          root={skillPath(selected)}
          initialPath={skillEntryPath(selected)}
          onDirtyChange={onDirtyChange}
        />
        : <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-1 px-6 text-center text-xs leading-6 text-txt3">
          <span>未选择 Skill</span>
        </div>}
    </div>
  </div>
}
