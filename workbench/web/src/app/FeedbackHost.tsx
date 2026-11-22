import { useFeedbackStore } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Modal } from '@/shared/ui/modal'
import { Icon } from '@/shared/ui/icon'
import { cn } from '@/shared/lib/utils'

export function FeedbackHost() {
  const { toasts, dismissToast, confirmation, finishConfirmation } = useFeedbackStore()
  return <>
    <Modal open={Boolean(confirmation)} title={confirmation?.title} width={440} onClose={() => finishConfirmation(false)} footer={<>
      <Button autoFocus onClick={() => finishConfirmation(false)}>取消</Button>
      <Button variant={confirmation?.danger ? 'danger' : 'primary'} onClick={() => finishConfirmation(true)}>{confirmation?.confirmLabel || '确认'}</Button>
    </>}><p className="text-sm leading-7 text-txt2">{confirmation?.description}</p></Modal>
    <div className="toast-region" aria-live="polite" aria-relevant="additions" aria-label="操作通知">
      {toasts.map(toast => <div key={toast.id} className={cn('toast-item', toast.kind === 'error' ? 'border-err/30' : 'border-line')}>
        <Icon name={toast.kind === 'error' ? 'warning' : 'check'} className={toast.kind === 'error' ? 'text-err' : 'text-ok'} />
        <p className="min-w-0 flex-1 break-words text-sm text-txt">{toast.message}</p>
        <button type="button" className="icon-button h-7 w-7" aria-label="关闭通知" onClick={() => dismissToast(toast.id)}><Icon name="close" size={15} /></button>
      </div>)}
    </div>
  </>
}
