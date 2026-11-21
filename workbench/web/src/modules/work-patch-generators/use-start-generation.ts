import { useRef } from 'react'
import { useNavigate } from 'react-router'
import { generationRunPath, startGeneration, type StartGeneration } from '@/shared/api/work-patch-generators'
import { useMutation } from '@/shared/hooks/use-mutation'
import { newUuid } from '@/shared/lib/uuid'

export function useStartGeneration() {
  const navigate = useNavigate()
  const mutation = useMutation()
  const pending = useRef<{ key: string; id: string } | null>(null)

  function start(body: StartGeneration) {
    void mutation.run(signal => {
      const key = JSON.stringify(body)
      // 请求结果未确认时，原样重试使用同一个 ID。
      if (pending.current?.key !== key) pending.current = { key, id: newUuid() }
      return startGeneration(pending.current.id, body, signal)
    }, run => {
      pending.current = null
      navigate(generationRunPath(run.id))
    })
  }

  return { busy: mutation.busy, error: mutation.error, start }
}
