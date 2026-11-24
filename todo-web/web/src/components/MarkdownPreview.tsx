import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Markdown 渲染单独成模块，按需加载，避免拖慢首屏。 */
export default function MarkdownPreview({ source }: { source: string }) {
  return (
    <div className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
    </div>
  )
}
