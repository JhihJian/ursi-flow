import type { ReactNode } from 'react'
import { useResource } from '../lib/use-resource'
import { copyText } from '../lib/clipboard'
import { useFeedback } from '../ui/feedback'
import { useMcp } from '../context'
import type { McpResource, ResourceContent } from '../client'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { ResourceState } from '../ui/resource-state'

/** 页面只显示正文前 16 KiB 字符，完整内容仍可复制。 */
const PREVIEW_LIMIT = 16_384

function blobBytes(blob: string): number {
  const padding = blob.endsWith('==') ? 2 : blob.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((blob.length * 3) / 4) - padding)
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} 字节`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / 1024 / 1024).toFixed(1)} MiB`
}

function useCopy() {
  const { notify } = useFeedback()
  return async (text: string, message: string) => {
    if (await copyText(text)) notify(message)
    else notify('浏览器未允许写入剪贴板，请手动选中后复制', 'error')
  }
}

function ContentMeta({ content, children }: { content: ResourceContent; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-txt3">
      <span className="min-w-0 break-all">{content.uri}</span>
      {content.mimeType ? <Badge variant="outline">{content.mimeType}</Badge> : null}
      {children}
    </div>
  )
}

/** 单个内容分片：文本按原文显示，二进制只说明大小，不解析也不渲染 HTML。 */
export function ResourceContentBlock({ content }: { content: ResourceContent }) {
  const copy = useCopy()
  const text = content.text
  if (text !== undefined) {
    const overflow = text.length > PREVIEW_LIMIT
    return (
      <div className="space-y-2">
        <ContentMeta content={content}>
          <Button size="sm" variant="ghost" icon="copy" onClick={() => { void copy(text, '已复制资源正文') }}>复制全文</Button>
        </ContentMeta>
        <pre className="whitespace-pre-wrap break-words border border-line bg-base p-3 font-mono text-xs leading-6 text-txt">
          {overflow ? text.slice(0, PREVIEW_LIMIT) : text}
        </pre>
        {overflow ? <p className="text-xs text-txt3">正文较长，只显示前 16 384 个字符。复制全文可得完整内容。</p> : null}
      </div>
    )
  }
  if (content.blob !== undefined) {
    return (
      <div className="space-y-2">
        <ContentMeta content={content} />
        <p className="border border-line bg-base p-3 text-sm leading-6 text-txt2">
          二进制内容，共 {formatBytes(blobBytes(content.blob))}，不在页面预览。
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <ContentMeta content={content} />
      <p className="border border-line bg-base p-3 text-sm leading-6 text-txt2">这项内容既没有文本也没有二进制正文，无法预览。</p>
    </div>
  )
}

export interface ResourcePreviewPanelProps {
  serverId: string
  resource: McpResource
}

/** 右侧预览：每次选中资源都重新读取一次，读取失败时保留失败原因并允许重试。 */
export function ResourcePreviewPanel({ serverId, resource }: ResourcePreviewPanelProps) {
  const { client } = useMcp()
  const copy = useCopy()
  const read = useResource(signal => client.readResource(serverId, resource.uri, signal), { contents: [] })
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <header className="flex flex-wrap items-start gap-2 border-b border-line pb-3">
        <div className="min-w-0 flex-auto">
          <h2 className="break-all text-base font-semibold text-txt">{resource.name}</h2>
          <p className="mt-1 break-all font-mono text-xs text-txt3">{resource.uri}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {resource.mimeType ? <Badge variant="outline">{resource.mimeType}</Badge> : null}
          <Button size="sm" icon="copy" onClick={() => { void copy(resource.uri, '已复制资源 URI') }}>复制 URI</Button>
          <Button size="sm" icon="refresh" loading={read.loading} onClick={read.reload}>重新读取</Button>
        </div>
      </header>
      <p role="status" className="text-xs text-txt3">
        {read.loading ? '正在读取' : read.error ? '本次读取失败' : `本次读取完成 · ${read.data.contents.length} 个内容分片`}
      </p>
      <ResourceState
        className="border-0 bg-transparent p-0"
        loading={read.loading}
        error={read.error}
        onRetry={read.reload}
        empty={!read.data.contents.length}
        title={read.error ? undefined : '服务未返回内容'}
        description={read.error ? undefined : '资源读取成功，但没有任何可展示的内容。'}
      />
      <div className="scroll-area min-h-0 flex-1 space-y-4 overflow-auto">
        {resource.description && <p className="whitespace-pre-wrap break-words text-sm text-txt2">{resource.description}</p>}
        {!read.loading && !read.error && read.data.contents.map((content, index) => (
          <ResourceContentBlock key={`${index}-${content.uri}`} content={content} />
        ))}
      </div>
    </div>
  )
}
