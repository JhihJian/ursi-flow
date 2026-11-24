import { useEffect, useState } from 'react'
import { keyName, keyToParent } from './api.ts'
import { useTreeStore } from './tree-store.ts'

interface DirActionsProps {
  /** 当前选中目录 key（含根）。 */
  selectedDirKey: string | null
  /** 受控的新建文件夹模式：true 时显示内联输入。 */
  creating?: boolean
  /** 新建输入关闭时回调（独立入口右键菜单触发时同步状态）。 */
  onCreatingDone?: () => void
}

/** 选中目录的新建文件夹输入条：输入一律内联，不用 prompt。
 *  常驻按钮条已并入树右键菜单，这里只承载新建文件夹的内联输入。 */
export function DirActions({ selectedDirKey, creating = false, onCreatingDone }: DirActionsProps) {
  const createDir = useTreeStore((state) => state.createDir)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const active = creating && selectedDirKey !== null

  useEffect(() => {
    if (creating) setName('')
  }, [creating])

  if (!active) return null

  const close = (): void => {
    setName('')
    onCreatingDone?.()
  }

  const submit = async (): Promise<void> => {
    if (!name.trim() || busy || !selectedDirKey) return
    setBusy(true)
    try {
      await createDir(selectedDirKey, name.trim())
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wsx-diractions">
      <span className="wsx-diractions-form">
        <input
          value={name}
          autoFocus
          placeholder={`在「${selectedDirKey ? keyName(selectedDirKey) : ''}」下新建文件夹`}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
            if (event.key === 'Escape') close()
          }}
        />
        <button type="button" disabled={busy} onClick={() => void submit()}>
          确定
        </button>
        <button type="button" onClick={close}>
          取消
        </button>
      </span>
    </div>
  )
}
