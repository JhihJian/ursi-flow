import { useEffect, useMemo } from 'react'
import type { Directory } from '@/modules/directories/api'
import { ResourceState } from '@/shared/ui/resource-state'
import { MCP_PATH, mcpError } from './model'
import { FileError } from './FileError'
import { SaveBar } from './SaveBar'
import { useTextFile } from './use-text-file'

/**
 * MCP：`mcp.json` 的原文编辑。合法性提示只影响保存按钮，
 * 草稿始终留在编辑器里，方便对照服务端要求修改。
 */
export function Mcp({ directory, onDirtyChange }: { directory: Directory; onDirtyChange?: (dirty: boolean) => void }) {
  const file = useTextFile(directory, MCP_PATH)
  const invalid = useMemo(() => mcpError(file.text), [file.text])

  useEffect(() => { onDirtyChange?.(file.dirty) }, [file.dirty, onDirtyChange])

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line px-1 pb-2">
      <span className="font-mono text-xs text-txt2">{MCP_PATH}</span>
      <span className="text-[11px] text-txt3">写入须为合法 JSON 对象，一般保留 mcpServers 字段。</span>
      {!file.loading && <SaveBar file={file} disabled={Boolean(invalid)} />}
    </div>
    {file.error ? <FileError message={file.error} onRetry={file.reload} /> : null}
    {!file.error && file.loading
      ? <ResourceState loading className="rounded-none border-0 shadow-none" />
      : <div className="flex min-h-0 flex-1 flex-col gap-2 pt-2">
        {invalid && <p role="alert" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">{invalid}</p>}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <textarea
            className="textarea min-h-0 flex-1 resize-none font-mono text-[13px] leading-6"
            aria-label="mcp.json 内容"
            aria-invalid={invalid ? 'true' : undefined}
            spellCheck={false}
            value={file.text}
            onChange={event => file.change(event.target.value)}
          />
        </div>
      </div>}
  </div>
}
