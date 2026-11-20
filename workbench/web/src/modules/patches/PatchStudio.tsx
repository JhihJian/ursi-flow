import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { Sheet, SheetContent } from '@/shared/ui/sheet'
import { directoryClient } from '@/modules/directories/api'
import { listPatches, type Patch, type PatchKind } from './api'
import { PatchOwner } from './PatchOwner'
import { ConfigEditor } from './ConfigEditor'
import { Explorer } from './Explorer'
import { PatchCreateDialog } from './PatchCreate'
import { patchKindMeta, patchListPath, patchPath, workPatchExecutePath } from './PatchModel'
import { PatchSwitchList, PatchSwitcher } from './PatchSwitcher'
import './studio.css'

/**
 * 包编辑台框架：顶部只放包切换与新建，内容区全部留给编辑器。
 * 编辑器的未保存拦截由 Explorer / ConfigEditor 自己负责；这里始终走路由切换，
 * 不以本地状态换包，因此离开前仍会经过它们的确认，确认后才由 key 重挂载。
 */
export function PatchStudio({ kind }: { kind: PatchKind }) {
  const meta = patchKindMeta[kind]
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  // 刚创建的记录可能还没出现在列表里，先用创建响应解析，避免新建后立刻报找不到。
  const [createdPatch, setCreatedPatch] = useState<Patch | null>(null)
  const patches = useResource((signal) => listPatches(kind, signal), [] as Patch[])
  const patch = patches.data.find((item) => item.id === id) ?? (createdPatch?.id === id ? createdPatch : null)
  const directoryId = patch?.directoryId ?? ''
  // 目录对象是编辑器的数据源，引用只随目录标识变化，普通渲染不能让它重新加载整棵树。
  const dir = useMemo(() => (directoryId ? directoryClient(directoryId) : null), [directoryId])
  const name = patch?.name ?? id

  function select(nextId: string) {
    setSheetOpen(false)
    if (nextId !== id) navigate(patchPath(kind, nextId))
  }

  function create() {
    setSheetOpen(false)
    setCreating(true)
  }

  function created(next: Patch) {
    setCreating(false)
    setCreatedPatch(next)
    navigate(patchPath(kind, next.id))
    patches.reload()
  }

  const switchList = (
    <PatchSwitchList
      patches={patches.data}
      activeId={id}
      loading={patches.loading}
      error={patches.error}
      onSelect={select}
      onCreate={create}
      onRetry={patches.reload}
    />
  )

  return (
    <div className="patch-studio" data-testid="patch-studio">
      <header className="patch-studio__bar">
        <Icon name={meta.icon} size={15} className="shrink-0 text-accent-2" />
        <PatchSwitcher
          className="hidden lg:flex"
          label={name}
          patches={patches.data}
          activeId={id}
          loading={patches.loading}
          error={patches.error}
          onRetry={patches.reload}
          onSelect={select}
          onCreate={create}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-txt lg:hidden">{name}</span>
        <Button
          data-testid="patch-switch"
          size="sm"
          variant="outline"
          icon="menu"
          className="min-h-9 shrink-0 lg:hidden"
          onClick={() => setSheetOpen(true)}
        >切换</Button>
        <Button
          size="icon"
          variant="outline"
          icon="plus"
          className="shrink-0 lg:hidden"
          aria-label={`新建${meta.title}`}
          onClick={create}
        />
        {kind === 'work' && patch && <Button size="sm" variant="outline" asChild>
          <Link to={workPatchExecutePath(patch.id)}>运行工作包</Link>
        </Button>}
        <div className="ml-auto hidden shrink-0 items-center gap-2 lg:flex">
          <Button size="sm" variant="ghost" asChild>
            <Link to={patchListPath(kind)}>全部{meta.title}</Link>
          </Button>
          <Button size="sm" variant="primary" icon="plus" onClick={create}>新建</Button>
        </div>
      </header>
      {patches.error ? (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs text-err">
          <span className="min-w-0 flex-1 break-words">包列表读取失败：{patches.error}</span>
          <Button size="sm" variant="ghost" icon="refresh" onClick={patches.reload}>重试</Button>
        </div>
      ) : null}
      {kind === 'work' && patch && <PatchOwner key={patch.id} patch={patch} onSaved={patches.reload} />}
      <div className="patch-studio__body">
        {dir
          ? kind === 'work'
            ? <Explorer key={`work/${directoryId}`} directory={dir} />
            : <ConfigEditor key={`config/${directoryId}`} directory={dir} />
          : patches.loading
            ? <p role="status" className="px-4 py-6 text-sm text-txt3">正在读取包记录…</p>
            : patches.error
              ? null
              : (
                <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-6 text-sm text-err">
                  <span className="min-w-0 flex-1 break-words">没有找到这个{meta.title}，它可能已被删除。</span>
                  <Button size="sm" variant="ghost" icon="refresh" onClick={patches.reload}>重试</Button>
                  <Button size="sm" variant="outline" asChild>
                    <Link to={patchListPath(kind)}>返回全部{meta.title}</Link>
                  </Button>
                </div>
              )}
      </div>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" title="切换包" className="max-h-[70dvh] lg:hidden">
          {switchList}
        </SheetContent>
      </Sheet>
      <PatchCreateDialog kind={kind} open={creating} onClose={() => setCreating(false)} onCreated={created} />
    </div>
  )
}

export function WorkPatchStudio() {
  return <PatchStudio kind="work" />
}

export function ConfigPatchStudio() {
  return <PatchStudio kind="config" />
}
