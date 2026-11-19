import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/shared/api'
import type { Directory } from '../api'

export interface TextFileState {
  /** 编辑器里的当前内容，未保存时与原文不同。 */
  text: string
  loading: boolean
  error: string
  saving: boolean
  /** 内容与磁盘原文不一致。 */
  dirty: boolean
  /** 最近一次保存成功后为 true，再次编辑后清除。 */
  saved: boolean
  change: (text: string) => void
  save: () => Promise<boolean>
  /** 丢弃未保存内容，回到磁盘原文。 */
  reset: () => void
  reload: () => void
}

/**
 * 单个文本文件的读取与显式保存：读到的内容作为基线，编辑只改本地草稿，
 * 保存成功才把基线推进到当前内容。保存失败保留草稿。
 * 写入一律覆盖（`replace`），因为三个锚点在补丁创建时已经存在。
 */
export function useTextFile(directory: Directory, path: string): TextFileState {
  const [text, setText] = useState('')
  const [baseline, setBaseline] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    setError('')
    try {
      const blob = await directory.read(path)
      const value = await blob.text()
      if (current !== generation.current) return
      setText(value)
      setBaseline(value)
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [directory, path])

  const invalidate = useCallback(() => { generation.current++ }, [])

  useEffect(() => {
    // 首次读取是同步外部系统（目录服务），不调用就不会有内容。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    return invalidate
  }, [load, invalidate])

  const change = useCallback((value: string) => {
    setText(value)
    setSaved(false)
    setError('')
  }, [])

  const save = useCallback(async () => {
    if (saving || text === baseline) return false
    setSaving(true)
    setError('')
    try {
      await directory.write(path, text, true)
      setBaseline(text)
      setSaved(true)
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setSaving(false)
    }
  }, [baseline, directory, path, saving, text])

  const reset = useCallback(() => {
    setText(baseline)
    setSaved(false)
    setError('')
  }, [baseline])

  return { text, loading, error, saving, dirty: text !== baseline, saved, change, save, reset, reload: () => { void load() } }
}
