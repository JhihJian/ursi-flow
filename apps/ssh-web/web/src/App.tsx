import { ConnectionEditorSheet } from './components/ConnectionEditorSheet'
import { ConnectionSidebar } from './components/ConnectionSidebar'
import { TerminalPane } from './components/TerminalPane'
import { useSshStore } from './store/ssh-store'

export default function App() {
  const notice = useSshStore((state) => state.notice)
  const setNotice = useSshStore((state) => state.setNotice)

  return (
    <div className="workspace">
      <div className="panel panel-sidebar">
        <ConnectionSidebar />
      </div>
      <div className="separator" />
      <div className="panel panel-content ssh-main">
        <TerminalPane />
        {notice ? (
          <div className="ssh-notice">
            <span className="ssh-notice-message">{notice}</span>
            <button
              type="button"
              className="ssh-notice-close"
              onClick={() => setNotice(null)}
              aria-label="关闭提示"
            >
              ×
            </button>
          </div>
        ) : null}
      </div>
      <ConnectionEditorSheet />
    </div>
  )
}
