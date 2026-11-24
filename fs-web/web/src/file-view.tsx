import { lazy, Suspense } from 'react'
import { keyName, keyToParent } from './api.ts'
import { useEditorStore } from './editor-store.ts'
import { useTreeStore } from './tree-store.ts'

const FileEditor = lazy(() => import('./file-editor.tsx'))

interface FileViewProps {
  fileKey: string
}

/** 外壳工作区区域：打开的文件渲染 Monaco；loading/error/conflict 分支。 */
export function FileView({ fileKey }: FileViewProps) {
  const entry = useEditorStore((state) => state.editors[fileKey])
  const updateDraft = useEditorStore((state) => state.updateDraft)
  const save = useEditorStore((state) => state.save)
  const discard = useEditorStore((state) => state.discard)
  const api = useTreeStore((state) => state.api)

  if (!entry) {
    return <div className="wsx-view-empty">文件未加载</div>
  }
  if (entry.status === 'loading') {
    return <div className="wsx-view-empty">加载中…</div>
  }
  if (entry.status === 'error') {
    return <div className="wsx-view-error">读取失败：{entry.error}</div>
  }

  const saveCurrent = (): void => {
    void save(api, fileKey)
  }

  return (
    <div className="wsx-view">
      <div className="wsx-view-bar">
        <span className="wsx-view-path">{keyToParent(fileKey) ? keyToParent(fileKey)!.parentKey : ''}</span>
        <span className="wsx-view-name">{keyName(fileKey)}</span>
        {entry.dirty ? <span className="wsx-view-dirty">未保存</span> : null}
        {entry.conflict ? (
          <span className="wsx-view-conflict">
            文件已在磁盘上被修改。覆盖保存将丢弃磁盘上的版本。
            <button
              type="button"
              onClick={() => {
                void save(api, fileKey, true)
              }}
            >
              覆盖保存
            </button>
            <button type="button" onClick={() => void discard(fileKey)}>
              放弃修改
            </button>
          </span>
        ) : (
          <button type="button" className="wsx-view-save" onClick={saveCurrent}>
            保存
          </button>
        )}
      </div>
      <div className="wsx-view-editor">
        <Suspense fallback={<div className="wsx-view-empty">编辑器加载中…</div>}>
          <FileEditor value={entry.draft} onChange={(value) => updateDraft(fileKey, value)} onSave={saveCurrent} pathLabel={keyName(fileKey)} />
        </Suspense>
      </div>
    </div>
  )
}
