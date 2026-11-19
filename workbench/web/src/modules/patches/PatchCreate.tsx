import { useState, type FormEvent } from 'react'

import { errorMessage } from '@/shared/api'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { createPatch, type Patch, type PatchKind } from './api'
import { patchKindMeta } from './PatchModel'

export interface PatchCreateDialogProps {
  kind: PatchKind
  open: boolean
  onClose: () => void
  onCreated: (patch: Patch) => void
}

/** 新建包只需要名称，内容由创建后的目录编辑器补齐。 */
export function PatchCreateDialog({ kind, open, onClose, onCreated }: PatchCreateDialogProps) {
  const meta = patchKindMeta[kind]
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const trimmed = name.trim()

  function close() {
    if (name) setName('')
    setError('')
    onClose()
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!trimmed || busy) return
    setBusy(true)
    setError('')
    try {
      const patch = await createPatch(kind, trimmed)
      setName('')
      onCreated(patch)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={`新建${meta.title}`}
      width={420}
      footer={(
        <>
          <Button onClick={close} disabled={busy}>取消</Button>
          <Button variant="primary" loading={busy} disabled={!trimmed} onClick={() => { void submit() }}>创建</Button>
        </>
      )}
    >
      <form onSubmit={(event) => { void submit(event) }}>
        <label className="field">
          <span className="field-label">名称</span>
          <Input
            value={name}
            onChange={(event) => { setName(event.target.value); setError('') }}
            placeholder={kind === 'work' ? '例如：结算异常排查' : '例如：审核助手配置'}
            disabled={busy}
          />
        </label>
        <p className="mt-2 text-xs leading-5 text-txt3">只需填写名称，创建后再整理包内文件。</p>
        {error ? <p role="alert" className="mt-3 text-sm text-err">{error}</p> : null}
      </form>
    </Modal>
  )
}
