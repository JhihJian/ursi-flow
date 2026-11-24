import { useState } from 'react'
import { keyName, keyToParent } from './api.ts'
import { useTreeStore } from './tree-store.ts'

interface DirActionsProps {
  /** 当前选中目录 key（含根）。 */
  selectedDirKey: string | null
  /** 破坏性操作确认（内联对话框）。 */
  confirm: (message: string) => Promise<boolean>
}

type Mode = 'idle' | 'create' | 'rename'

/** 选中目录的操作条：刷新、新建文件夹、重命名、删除。输入一律内联，不用 prompt。 */
export function DirActions({ selectedDirKey, confirm }: DirActionsProps) {
  const refreshAll = useTreeStore((state) => state.refreshAll)
  const createDir = useTreeStore((state) => state.createDir)
  const renameEntry = useTreeStore((state) => state.renameEntry)
  const removeEntry = useTreeStore((state) => state.removeEntry)
  const [mode, setMode] = useState<Mode>('idle')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  if (!selectedDirKey) return null
  const isRoot = !keyToParent(selectedDirKey)

  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      if (mode === 'create') {
        await createDir(selectedDirKey, name.trim())
      } else if (mode === 'rename') {
        await renameEntry(selectedDirKey, name.trim())
      }
      setMode('idle')
      setName('')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (busy) return
    const ok = await confirm(`删除目录「${keyName(selectedDirKey)}」？目录内容将被递归删除，不可恢复。`)
    if (!ok) return
    setBusy(true)
    try {
      await removeEntry(selectedDirKey)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wsx-diractions">
      <button type="button" disabled={busy} onClick={() => void refreshAll()}>
        刷新
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setMode(mode === 'create' ? 'idle' : 'create')
          setName('')
        }}
      >
        新建文件夹
      </button>
      {!isRoot ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setMode(mode === 'rename' ? 'idle' : 'rename')
              setName(keyName(selectedDirKey))
            }}
          >
            重命名
          </button>
          <button type="button" disabled={busy} onClick={() => void remove()}>
            删除
          </button>
        </>
      ) : null}
      {mode !== 'idle' ? (
        <span className="wsx-diractions-form">
          <input
            value={name}
            autoFocus
            placeholder={mode === 'create' ? '新文件夹名' : '新名称'}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
              if (event.key === 'Escape') setMode('idle')
            }}
          />
          <button type="button" disabled={busy} onClick={() => void submit()}>
            确定
          </button>
          <button type="button" onClick={() => setMode('idle')}>
            取消
          </button>
        </span>
      ) : null}
    </div>
  )
}
