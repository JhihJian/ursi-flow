import { MODELS } from '@/lib/models'
import { Chat } from '@/components/chat'
import { SiteHeader } from '@/components/site-header'

export default function App() {
  return (
    <div className="chat-shell">
      <SiteHeader />
      <Chat models={MODELS} />
    </div>
  )
}
