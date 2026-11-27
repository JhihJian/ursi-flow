import { usePi } from './pi-context'
import { usePiNav } from './pi-nav'
import { Composer } from './composer'
import { shortRoot } from './views/sessions/lib/format'

/** 新对话页：没有表单，目录来自侧栏点选，这里只有输入框。 */
export function DraftPage() {
  const { home } = usePi()
  const { cwd } = usePiNav()

  return (
    <div className="pichat pichat-workspace">
      <header className="pichat-bar">
        <span className="pichat-bar-title">新对话</span>
        <span className="pichat-bar-meta" title={cwd ?? home?.path}>
          {cwd ? shortRoot(cwd) : home ? `${home.name} · 点左侧一个目录` : '未选 pi home'}
        </span>
      </header>
      <div className="pichat-thread">
        <div className="pichat-center">
          <p>{cwd ? `工作目录 ${cwd}` : '在左侧点一个目录，或者点一条会话。'}</p>
          <p className="pichat-hint">模型与思考级别在下面选，发出第一条消息才建会话。</p>
        </div>
      </div>
      <Composer mode="draft" />
    </div>
  )
}
