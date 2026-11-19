import { Button } from '@/shared/ui/button'
import { Modal } from '@/shared/ui/modal'

export interface UnsavedDialogProps {
  path: string
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

/** 切换文件或返回列表前的未保存保护：保存、放弃或取消，不会静默丢弃编辑。 */
export function UnsavedDialog({ path, saving, onSave, onDiscard, onCancel }: UnsavedDialogProps) {
  return (
    <Modal
      open
      title="有未保存的更改"
      width={440}
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button variant="destructive" onClick={onDiscard} disabled={saving}>放弃更改</Button>
          <Button variant="primary" loading={saving} onClick={onSave}>保存并继续</Button>
        </>
      )}
    >
      <p className="break-words text-[13px] leading-6 text-txt2">
        <span className="font-mono text-txt">{path}</span> 还有未保存的修改。继续操作前请选择如何处理这些修改。
      </p>
    </Modal>
  )
}
