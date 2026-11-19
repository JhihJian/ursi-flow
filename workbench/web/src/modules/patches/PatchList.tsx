import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { listPatches, type Patch, type PatchKind } from './api'
import { PatchCreateDialog } from './PatchCreate'
import { patchKindMeta, patchPath } from './PatchModel'

export function PatchList({ kind }: { kind: PatchKind }) {
  const meta = patchKindMeta[kind]
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const patches = useResource((signal) => listPatches(kind, signal), [] as Patch[])
  const firstLoad = patches.loading && patches.data.length === 0
  const empty = !patches.loading && !patches.error && patches.data.length === 0
  const create = () => setCreating(true)
  const created = (patch: Patch) => {
    setCreating(false)
    navigate(patchPath(kind, patch.id))
  }

  return (
    <div className="page-stack break-words">
      <PageHeader
        title={meta.title}
        description={meta.description}
        actions={(
          <>
            <Button icon="refresh" onClick={patches.reload} disabled={patches.loading}>刷新</Button>
            <Button variant="primary" icon="plus" onClick={create}>新建{meta.title}</Button>
          </>
        )}
      />
      <ResourceState
        loading={firstLoad}
        error={patches.error}
        empty={empty}
        title={patches.error ? undefined : `暂无${meta.title}`}
        description={patches.error ? undefined : '新建后即可开始整理包内文件。'}
        onRetry={patches.reload}
      >
        <Button variant="primary" icon="plus" onClick={create}>新建{meta.title}</Button>
      </ResourceState>
      {!patches.error && patches.data.length > 0 ? (
        <div className="border-y border-line">
          <ul className="divide-y divide-line">
            {patches.data.map((patch) => (
              <li key={patch.id}>
                <Link
                  to={patchPath(kind, patch.id)}
                  className="flex min-w-0 items-center gap-3 px-4 py-4 hover:bg-elevated"
                >
                  <Icon name={meta.icon} size={18} className="shrink-0 text-txt3" />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate font-medium text-txt">{patch.name}</strong>
                    <small className="mt-1 block break-all font-mono text-xs text-txt3">{patch.id}</small>
                  </span>
                  <Icon name="chevron-right" size={16} className="shrink-0 text-txt3" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <PatchCreateDialog kind={kind} open={creating} onClose={() => setCreating(false)} onCreated={created} />
    </div>
  )
}

export function WorkPatchList() {
  return <PatchList kind="work" />
}

export function ConfigPatchList() {
  return <PatchList kind="config" />
}
