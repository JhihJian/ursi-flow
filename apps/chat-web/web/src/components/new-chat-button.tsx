import { RiAddLine } from '@remixicon/react'

import { Button } from '@/components/ui/button'

export function NewChatButton() {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => window.location.reload()}
    >
      <RiAddLine className="btn-icon-inline" />
      New Chat
    </Button>
  )
}
