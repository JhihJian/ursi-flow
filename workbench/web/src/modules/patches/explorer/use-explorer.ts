import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'

import { errorMessage } from '@/shared/api'
import { confirmAction, notify } from '@/shared/stores/feedback'

import {
  basename, decodeBlob, formatBytes, isMarkdownPath, isSameOrInside, isWithin, joinPath, languageOf, normalizePath, parentPath,
} from './paths'
import { ancestorsOf, buildTree, missingAncestors, treePaths, visibleRows, type TreeRow } from './tree'
import type { Directory, Entry } from '@/modules/directories/api'

export type ExplorerStep = 'list' | 'edit'
export type MarkdownViewMode = 'edit' | 'split' | 'preview'

export interface OpenDoc {
  path: string
  loading: boolean
  error: string
  /** 当前编辑内容；二进制文件恒为空。 */
  text: string
  /** 最近一次读取或保存的内容，用于判定未保存修改。 */
  saved: string
  binary: boolean
  size: number
  blob: Blob | null
}

export interface CtxTarget {
  dir: boolean
  path: string
  name: string
  /** 空白区域（显示范围的根）。 */
  blank?: boolean
}

export type CtxAction = 'newFile' | 'newFolder' | 'uploadFile' | 'importDir' | 'rename' | 'copyPath' | 'download' | 'delete'

export interface ExplorerOptions {
  directory: Directory
  /** 只显示该路径下的条目；API 仍使用包根相对路径。 */
  root?: string
  initialPath?: string
  /** 窄屏布局：树与编辑器分步显示。 */
  compact: boolean
  /** 由资源管理器渲染的上传与导入文件输入框。 */
  fileInput: RefObject<HTMLInputElement | null>
  dirInput: RefObject<HTMLInputElement | null>
}

const VIEW_MODE_KEY = 'work-patch-explorer-md-view'
const COLLAPSED_KEY = 'work-patch-explorer-collapsed'

function readViewMode(): MarkdownViewMode {
  try {
    const value = localStorage.getItem(VIEW_MODE_KEY)
    return value === 'edit' || value === 'split' || value === 'preview' ? value : 'split'
  } catch {
    return 'split'
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 存储不可用时只保留内存状态。 */
  }
}

export function isDirtyDoc(doc: OpenDoc | undefined): boolean {
  return Boolean(doc && !doc.binary && !doc.loading && !doc.error && doc.text !== doc.saved)
}

/** 目录导入时去掉选择的顶层目录名，保留其下的相对路径。 */
export function uploadRelativePath(file: File): string {
  const segments = (file.webkitRelativePath || '').split('/').filter(Boolean)
  if (segments.length > 1) return segments.slice(1).join('/')
  return file.name
}

function downloadBlob(blob: Blob, filename: string) {
  if (typeof URL.createObjectURL !== 'function') {
    notify('当前浏览器不支持直接下载，请改用其他方式获取该文件。', 'error')
    return
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.click()
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

export function useExplorer(options: ExplorerOptions) {
  const { directory, compact } = options
  const base = normalizePath(options.root ?? '')

  const [entries, setEntries] = useState<Entry[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [creating, setCreating] = useState<{ dir: string; kind: 'file' | 'folder' } | null>(null)
  const [createName, setCreateName] = useState('')
  const [docs, setDocs] = useState<Record<string, OpenDoc>>({})
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [step, setStep] = useState<ExplorerStep>('list')
  const [ctx, setCtx] = useState<{ x: number; y: number; target: CtxTarget } | null>(null)
  const [pending, setPending] = useState<{ path: string; run: () => void } | null>(null)
  const [saving, setSaving] = useState('')
  const [viewMode, setViewModeState] = useState<MarkdownViewMode>(readViewMode)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const stateRef = useRef<{ active: string | null; docs: Record<string, OpenDoc>; tabs: string[] }>({ active: null, docs: {}, tabs: [] })
  useEffect(() => { stateRef.current = { active, docs, tabs } })

  const docLoads = useRef(new Map<string, number>())
  const uploadDir = useRef('')
  const appliedInitial = useRef('')
  const autoSelected = useRef(false)
  // 回车确认后输入框卸载仍可能触发 blur，用一次性标记避免重复创建或重复移动。
  const createSettled = useRef(false)
  const renameSettled = useRef(false)

  const tree = useMemo(() => buildTree(entries, base), [entries, base])
  const index = useMemo(() => treePaths(tree), [tree])
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded])
  const doc = active ? docs[active] : undefined
  const dirty = isDirtyDoc(doc)
  const dirtyPaths = useMemo(
    () => Object.values(docs).filter(isDirtyDoc).map(item => item.path),
    [docs],
  )


  const fetchTree = useCallback(async (signal?: AbortSignal) => {
    setTreeLoading(true)
    setTreeError('')
    try {
      const list = await directory.tree(signal)
      if (!signal?.aborted) setEntries(list)
      return list
    } catch (cause) {
      if (!signal?.aborted) setTreeError(errorMessage(cause))
      return [] as Entry[]
    } finally {
      if (!signal?.aborted) setTreeLoading(false)
    }
  }, [directory])

  // 切换目录或显示范围时清空打开状态，避免把上一个包的路径带到新包。
  useEffect(() => {
    appliedInitial.current = ''
    autoSelected.current = false
    docLoads.current.clear()
    setEntries([])
    setTreeError('')
    setExpanded(new Set())
    setSelected('')
    setRenaming(null)
    setCreating(null)
    setCtx(null)
    setPending(null)
    setTabs([])
    setDocs({})
    setActive(null)
    setStep('list')
    const controller = new AbortController()
    void fetchTree(controller.signal)
    return () => { controller.abort() }
  }, [fetchTree])

  const reload = useCallback(async () => fetchTree(), [fetchTree])

  /** 写入前补齐缺少的父目录，导入深层路径时也能一次成功。 */
  const ensureDirs = useCallback(async (path: string) => {
    for (const dir of missingAncestors(path, base, index.dirs)) await directory.mkdir(dir)
  }, [base, directory, index])

  const loadDoc = useCallback(async (path: string) => {
    const generation = (docLoads.current.get(path) ?? 0) + 1
    docLoads.current.set(path, generation)
    setDocs(previous => ({
      ...previous,
      [path]: { path, loading: true, error: '', text: '', saved: '', binary: false, size: 0, blob: null },
    }))
    try {
      const blob = await directory.read(path)
      const loaded = await decodeBlob(blob, path)
      if (docLoads.current.get(path) !== generation) return
      setDocs(previous => ({
        ...previous,
        [path]: {
          path,
          loading: false,
          error: '',
          text: loaded.text,
          saved: loaded.text,
          binary: loaded.binary,
          size: loaded.size,
          blob: loaded.binary ? blob : null,
        },
      }))
    } catch (cause) {
      if (docLoads.current.get(path) !== generation) return
      setDocs(previous => ({
        ...previous,
        [path]: {
          path, loading: false, error: errorMessage(cause), text: '', saved: '', binary: false, size: 0, blob: null,
        },
      }))
    }
  }, [directory])

  const openDoc = useCallback((path: string, mode: ExplorerStep = 'edit') => {
    const current = stateRef.current
    if (current.active === path && current.docs[path]) {
      if (mode === 'edit' && compact) setStep('edit')
      return
    }
    setActive(path)
    setSelected(path)
    setTabs(previous => (previous.includes(path) ? previous : [...previous, path]))
    setExpanded(previous => {
      const next = new Set(previous)
      for (const dir of ancestorsOf(path, base)) next.add(dir)
      return next
    })
    if (mode === 'edit' && compact) setStep('edit')
    void loadDoc(path)
  }, [base, compact, loadDoc])

  // 首次载入后优先打开指定文件，否则选目录中的第一个 Markdown 或首个文件。
  useEffect(() => {
    if (!entries.length) return
    const requested = normalizePath(options.initialPath ?? '')
    if (requested && appliedInitial.current !== requested) {
      if (entries.some(entry => entry.kind === 'file' && normalizePath(entry.path) === requested)) {
        appliedInitial.current = requested
        openDoc(requested)
        return
      }
    }
    if (autoSelected.current) return
    autoSelected.current = true
    if (compact) return
    const files = entries
      .filter(entry => entry.kind === 'file' && isWithin(normalizePath(entry.path), base))
      .map(entry => normalizePath(entry.path))
      .sort((left, right) => left.localeCompare(right))
    const pick = files.find(isMarkdownPath) ?? files[0]
    if (pick) openDoc(pick, 'list')
  }, [base, compact, entries, openDoc, options.initialPath])

  /** 离开当前文件前的未保存保护：保存、放弃或取消。 */
  const guardActive = useCallback((run: () => void) => {
    const current = stateRef.current
    const currentDoc = current.active ? current.docs[current.active] : undefined
    if (isDirtyDoc(currentDoc) && current.active) {
      setPending({ path: current.active, run })
      return
    }
    run()
  }, [])

  const requestOpen = useCallback((path: string) => {
    if (stateRef.current.active === path) {
      if (compact) setStep('edit')
      return
    }
    guardActive(() => openDoc(path))
  }, [compact, guardActive, openDoc])

  const requestBackToList = useCallback(() => {
    guardActive(() => setStep('list'))
  }, [guardActive])

  const saveDoc = useCallback(async (path?: string) => {
    const target = path ?? stateRef.current.active
    if (!target) return true
    const current = stateRef.current.docs[target]
    if (!current || current.binary || current.loading || current.text === current.saved) return true
    const text = current.text
    setSaving(target)
    try {
      await directory.write(target, text, true)
      setDocs(previous => {
        const latest = previous[target]
        if (!latest || latest.text !== text) return previous
        return { ...previous, [target]: { ...latest, saved: text } }
      })
      return true
    } catch (cause) {
      notify(errorMessage(cause), 'error')
      return false
    } finally {
      setSaving('')
    }
  }, [directory])

  const saveActive = useCallback(async () => {
    const path = stateRef.current.active
    if (!path) return true
    const ok = await saveDoc(path)
    if (ok) notify('已保存。')
    return ok
  }, [saveDoc])

  const pendingSave = useCallback(async () => {
    const task = pending
    if (!task) return
    const ok = await saveDoc(task.path)
    if (!ok) return
    setPending(null)
    task.run()
  }, [pending, saveDoc])

  const pendingDiscard = useCallback(() => {
    const task = pending
    if (!task) return
    setDocs(previous => {
      const latest = previous[task.path]
      if (!latest) return previous
      return { ...previous, [task.path]: { ...latest, text: latest.saved } }
    })
    setPending(null)
    task.run()
  }, [pending])

  const pendingCancel = useCallback(() => { setPending(null) }, [])

  const updateText = useCallback((path: string, text: string) => {
    setDocs(previous => {
      const latest = previous[path]
      if (!latest || latest.text === text) return previous
      return { ...previous, [path]: { ...latest, text } }
    })
  }, [])

  const closeTab = useCallback((path: string) => {
    const close = () => {
      const current = stateRef.current
      const position = current.tabs.indexOf(path)
      const nextTabs = current.tabs.filter(item => item !== path)
      setTabs(nextTabs)
      setDocs(previous => {
        const next = { ...previous }
        delete next[path]
        return next
      })
      docLoads.current.delete(path)
      if (current.active === path) setActive(nextTabs[Math.min(position, nextTabs.length - 1)] ?? null)
      if (!nextTabs.length) setStep('list')
    }
    if (stateRef.current.active !== path) {
      close()
      return
    }
    guardActive(close)
  }, [guardActive])

  const setActiveTab = useCallback((path: string) => {
    guardActive(() => openDoc(path))
  }, [guardActive, openDoc])

  const startRename = useCallback((row: TreeRow) => {
    setCreating(null)
    renameSettled.current = false
    setRenaming(row.path)
    setRenameName(row.name)
    setCtx(null)
  }, [])

  const cancelRename = useCallback(() => {
    renameSettled.current = true
    setRenaming(null)
  }, [])

  const remapByMove = useCallback((from: string, to: string) => {
    const remap = (path: string) => (isSameOrInside(path, from) ? to + path.slice(from.length) : path)
    setTabs(previous => previous.map(remap))
    setDocs(previous => {
      const next: Record<string, OpenDoc> = {}
      for (const [key, value] of Object.entries(previous)) {
        const path = remap(key)
        next[path] = { ...value, path }
      }
      return next
    })
    setExpanded(previous => new Set([...previous].map(remap)))
    setActive(current => (current ? remap(current) : current))
    setSelected(current => (current ? remap(current) : current))
  }, [])

  const commitRename = useCallback(async () => {
    if (!renaming || renameSettled.current) return
    renameSettled.current = true
    const from = renaming
    const row = rows.find(item => item.path === from)
    const leaf = renameName.trim().replace(/^\/+|\/+$/g, '')
    setRenaming(null)
    if (!row || !leaf || leaf === row.name) return
    if (leaf.split('/').some(segment => segment === '..' || segment === '\0')) {
      notify('路径不能包含 .. 或非法字符。', 'error')
      return
    }
    // 含 / 时按包内（或 root 内）路径移动，否则只在原目录内改名。
    const to = leaf.includes('/') ? joinPath(base, leaf) : joinPath(parentPath(from), leaf)
    if (!to || to === from) return
    if (row.dir && isSameOrInside(to, row.path)) {
      notify('不能把目录移动到自身内部。', 'error')
      return
    }
    if (index.files.has(to) || index.dirs.has(to)) {
      notify(`已存在 ${to}。`, 'error')
      return
    }
    try {
      await ensureDirs(to)
      await directory.move(from, to)
      remapByMove(from, to)
      await reload()
      setExpanded(previous => new Set([...previous, ...ancestorsOf(to, base)]))
      setSelected(to)
    } catch (cause) {
      notify(errorMessage(cause), 'error')
    }
  }, [base, directory, ensureDirs, index, reload, remapByMove, renameName, renaming, rows])

  const startCreate = useCallback((kind: 'file' | 'folder', dir: string) => {
    setRenaming(null)
    createSettled.current = false
    setCtx(null)
    setCreateName('')
    setCreating({ dir: normalizePath(dir), kind })
    setExpanded(previous => {
      const next = new Set(previous)
      const target = normalizePath(dir)
      if (target) {
        for (const ancestor of ancestorsOf(target, base)) next.add(ancestor)
        next.add(target)
      }
      return next
    })
  }, [base])

  const cancelCreate = useCallback(() => {
    createSettled.current = true
    setCreating(null)
    setCreateName('')
  }, [])

  const commitCreate = useCallback(async () => {
    if (!creating || createSettled.current) return
    createSettled.current = true
    const draft = creating
    const name = createName.trim().replace(/^\/+|\/+$/g, '')
    setCreating(null)
    setCreateName('')
    if (!name) return
    const full = joinPath(draft.dir, name)
    if (!full) return
    try {
      await ensureDirs(full)
      if (draft.kind === 'folder') {
        if (index.files.has(full)) {
          notify(`已存在同名文件 ${full}。`, 'error')
          return
        }
        if (!index.dirs.has(full)) await directory.mkdir(full)
        await reload()
        setExpanded(previous => new Set([...previous, ...ancestorsOf(full, base), full]))
        setSelected(full)
        return
      }
      if (index.files.has(full) || index.dirs.has(full)) {
        notify(`已存在 ${full}。`, 'error')
        return
      }
      await directory.write(full, '', false)
      await reload()
      openDoc(full)
    } catch (cause) {
      notify(errorMessage(cause), 'error')
    }
  }, [base, createName, creating, directory, ensureDirs, index, openDoc, reload])

  const copyPath = useCallback(async (path: string) => {
    if (!navigator.clipboard?.writeText) {
      notify(`当前浏览器不支持自动复制，路径为 ${path}。`, 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(path)
      notify(`已复制路径 ${path}。`)
    } catch {
      notify('复制路径失败，请手动选择路径。', 'error')
    }
  }, [])

  const downloadPath = useCallback(async (path: string) => {
    const loaded = stateRef.current.docs[path]?.blob
    if (loaded) {
      downloadBlob(loaded, basename(path))
      return
    }
    try {
      downloadBlob(await directory.read(path), basename(path))
    } catch (cause) {
      notify(errorMessage(cause), 'error')
    }
  }, [directory])

  const requestDelete = useCallback(async (row: TreeRow) => {
    const accepted = await confirmAction({
      title: row.dir ? '删除目录？' : '删除文件？',
      description: row.dir ? `将删除 ${row.path} 及其中的全部内容。` : `将删除 ${row.path}。`,
      danger: true,
      confirmLabel: '删除',
    })
    if (!accepted) return
    try {
      await directory.remove(row.path)
      const current = stateRef.current
      const nextTabs = current.tabs.filter(path => !isSameOrInside(path, row.path))
      setTabs(nextTabs)
      setDocs(previous => {
        const next: Record<string, OpenDoc> = {}
        for (const [path, value] of Object.entries(previous)) {
          if (!isSameOrInside(path, row.path)) next[path] = value
        }
        return next
      })
      if (current.active && isSameOrInside(current.active, row.path)) {
        setActive(nextTabs[nextTabs.length - 1] ?? null)
      }
      if (!nextTabs.length) setStep('list')
      setExpanded(previous => new Set([...previous].filter(dir => !isSameOrInside(dir, row.path))))
      setSelected(current => (current && isSameOrInside(current, row.path) ? '' : current))
      await reload()
      notify('已删除。')
    } catch (cause) {
      notify(errorMessage(cause), 'error')
    }
  }, [directory, reload])

  const uploadFiles = useCallback(async (files: File[], dir: string) => {
    if (!files.length) return
    const targetDir = normalizePath(dir)
    const plan = files
      .map(file => ({ file, path: joinPath(targetDir, uploadRelativePath(file)), replace: false }))
      .filter(item => Boolean(item.path))
    if (!plan.length) return
    const conflicts = plan.filter(item => index.files.has(item.path))
    const blocked = plan.filter(item => index.dirs.has(item.path))
    if (blocked.length) {
      notify(`${blocked.map(item => item.path).join('、')} 是目录，已跳过。`, 'error')
    }
    if (conflicts.length) {
      const accepted = await confirmAction({
        title: '覆盖已存在的文件？',
        description: `${conflicts.map(item => item.path).join('、')} 已存在，继续将替换其内容。`,
        confirmLabel: '覆盖并上传',
      })
      if (!accepted) {
        notify('已取消上传。')
        return
      }
      for (const item of conflicts) item.replace = true
    }
    let done = 0
    const failures: string[] = []
    for (const item of plan) {
      if (blocked.includes(item)) continue
      try {
        await ensureDirs(item.path)
        await directory.write(item.path, item.file, item.replace)
        done++
      } catch (cause) {
        failures.push(`${item.path}: ${errorMessage(cause)}`)
      }
    }
    if (done) {
      await reload()
      setExpanded(previous => {
        const next = new Set(previous)
        if (targetDir) next.add(targetDir)
        return next
      })
      notify(`已上传 ${done} 个文件${targetDir ? `到 ${targetDir}/` : ''}。`)
    }
    if (failures.length) notify(failures.join('；'), 'error')
  }, [directory, ensureDirs, index, reload])

  const pickUpload = useCallback((dir: string) => {
    uploadDir.current = normalizePath(dir)
    options.fileInput.current?.click()
  }, [options.fileInput])

  const pickImport = useCallback((dir: string) => {
    uploadDir.current = normalizePath(dir)
    options.dirInput.current?.click()
  }, [options.dirInput])

  const onUploadPicked = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const files = Array.from(input.files ?? [])
    input.value = ''
    void uploadFiles(files, uploadDir.current)
  }, [uploadFiles])

  const onImportPicked = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const files = Array.from(input.files ?? [])
    input.value = ''
    void uploadFiles(files, uploadDir.current)
  }, [uploadFiles])

  const openRowContext = useCallback((event: ReactMouseEvent, target: CtxTarget, point?: { x: number; y: number }) => {
    event.preventDefault()
    event.stopPropagation()
    if (!target.dir) setSelected(target.path)
    setCreating(null)
    setCtx({ x: point?.x ?? event.clientX, y: point?.y ?? event.clientY, target })
  }, [])

  const openBlankContext = useCallback((event: ReactMouseEvent) => {
    openRowContext(event, { dir: true, path: base, name: base || '包根目录', blank: true })
  }, [base, openRowContext])

  const onCreate = useCallback((row: TreeRow, event?: React.MouseEvent) => {
    event?.stopPropagation()
    startCreate('file', row.dir ? row.path : parentPath(row.path))
  }, [startCreate])

  const onCreateFolder = useCallback((row: TreeRow, event?: React.MouseEvent) => {
    event?.stopPropagation()
    startCreate('folder', row.dir ? row.path : parentPath(row.path))
  }, [startCreate])

  const onRenameRow = useCallback((row: TreeRow, event?: React.MouseEvent) => {
    event?.stopPropagation()
    startRename(row)
  }, [startRename])

  const onDeleteRow = useCallback((row: TreeRow, event?: React.MouseEvent) => {
    event?.stopPropagation()
    void requestDelete(row)
  }, [requestDelete])

  const onCtxAction = useCallback((action: CtxAction) => {
    const target = ctx?.target
    setCtx(null)
    if (!target) return
    const row: TreeRow = { name: target.name, path: target.path, dir: target.dir, depth: 0 }
    const dir = target.dir ? target.path : parentPath(target.path)
    switch (action) {
      case 'newFile': startCreate('file', dir); break
      case 'newFolder': startCreate('folder', dir); break
      case 'uploadFile': pickUpload(dir); break
      case 'importDir': pickImport(dir); break
      case 'rename': startRename(row); break
      case 'copyPath': void copyPath(target.path); break
      case 'download': void downloadPath(target.path); break
      case 'delete': void requestDelete(row); break
    }
  }, [copyPath, ctx, downloadPath, pickImport, pickUpload, requestDelete, startCreate, startRename])

  const toggleDir = useCallback((path: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggleCollapsed = useCallback(() => {
    setCollapsed(previous => {
      persist(COLLAPSED_KEY, String(!previous))
      return !previous
    })
  }, [])

  const setViewMode = useCallback((mode: MarkdownViewMode) => {
    persist(VIEW_MODE_KEY, mode)
    setViewModeState(mode)
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (ctx) { setCtx(null); return }
        if (renaming) { setRenaming(null); return }
        if (creating) { setCreating(null); setCreateName(''); return }
      }
      if (event.key === 'F2' && selected && !renaming) {
        const row = rows.find(item => item.path === selected)
        if (row) {
          event.preventDefault()
          startRename(row)
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        if (!stateRef.current.active) return
        event.preventDefault()
        void saveActive()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [creating, ctx, renaming, rows, saveActive, selected, startRename])

  const stats = doc && !doc.binary && !doc.loading && !doc.error
    ? {
        language: languageOf(doc.path),
        lines: doc.text.split('\n').length,
        characters: doc.text.length,
        size: formatBytes(doc.size),
      }
    : null

  return {
    // 数据
    rows, treeLoading, treeError, reload, base,
    // 树交互
    expanded, toggleDir, selected, setSelected, renaming, renameName, setRenameName, startRename, cancelRename, commitRename,
    creating, createName, setCreateName, startCreate, cancelCreate, commitCreate,
    onCreate, onCreateFolder, onRenameRow, onDeleteRow,
    // 上下文菜单
    ctx, openRowContext, openBlankContext, onCtxAction, closeCtx: () => setCtx(null),
    // 标签与文档
    tabs, active, doc, dirty, dirtyPaths, step, saving, stats, viewMode, setViewMode,
    requestOpen, setActiveTab, closeTab, updateText, saveActive, saveDoc, requestBackToList, reloadDoc: loadDoc,
    // 移动、删除、上传
    requestDelete, pickUpload, pickImport, onUploadPicked, onImportPicked, uploadFiles, downloadPath,
    // 未保存保护
    pending, pendingSave, pendingDiscard, pendingCancel,
    // 布局
    collapsed, toggleCollapsed,
  }
}

export type ExplorerController = ReturnType<typeof useExplorer>
