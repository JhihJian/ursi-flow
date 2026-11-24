import { NewChatButton } from '@/components/new-chat-button'

export function SiteHeader() {
  return (
    <header className="site-header">
      <span className="site-header-title">Chat</span>
      <NewChatButton />
    </header>
  )
}
