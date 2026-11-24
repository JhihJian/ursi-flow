import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './button'
import { Modal } from './modal'

type Confirmation = { title: string; description: string; confirmLabel: string; danger?: boolean }
type Notice = { message: string; kind: 'success' | 'error' }
const Feedback = createContext<{
  notify: (message: string, kind?: Notice['kind']) => void
  confirmAction: (options: Confirmation) => Promise<boolean>
} | null>(null)

export function useFeedback() {
  const feedback = useContext(Feedback)
  if (!feedback) throw new Error('缺少 MCP 反馈组件')
  return feedback
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null)
  const [question, setQuestion] = useState<Confirmation | null>(null)
  const resolve = useRef<((accepted: boolean) => void) | null>(null)
  useEffect(() => () => { resolve.current?.(false) }, [])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4500)
    return () => clearTimeout(timer)
  }, [notice])
  function finish(accepted: boolean) {
    resolve.current?.(accepted)
    resolve.current = null
    setQuestion(null)
  }
  return <Feedback.Provider value={{
    notify: (message, kind = 'success') => setNotice({ message, kind }),
    confirmAction: options => { resolve.current?.(false); setQuestion(options); return new Promise(done => { resolve.current = done }) },
  }}>
    {children}
    {notice && <div className="panel fixed bottom-4 right-4 z-[70] flex items-center gap-3 p-3" role={notice.kind === 'error' ? 'alert' : 'status'}>
      {notice.message}<Button icon="close" size="icon" aria-label="关闭通知" onClick={() => setNotice(null)} />
    </div>}
    {question && <Modal open title={question.title} onClose={() => finish(false)} footer={<>
      <Button onClick={() => finish(false)}>取消</Button>
      <Button variant={question.danger ? 'danger' : 'primary'} onClick={() => finish(true)}>{question.confirmLabel}</Button>
    </>}>{question.description}</Modal>}
  </Feedback.Provider>
}
