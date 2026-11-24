import * as React from 'react'
import {
  RiCheckLine,
  RiFileCopyLine,
  RiRestartLine,
} from '@remixicon/react'

import { Button } from '@/components/ui/button'
import { MessageFooter } from '@/components/ui/message'

export function MessageActions({
  text,
  onRetry,
}: {
  text: string
  onRetry?: () => void
}) {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timeout = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timeout)
  }, [copied])

  return (
    <MessageFooter className="message-actions">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() => {
          navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch(() => {})
        }}
      >
        {copied ? <RiCheckLine /> : <RiFileCopyLine />}
      </Button>
      {onRetry && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Retry"
          title="Retry"
          onClick={onRetry}
        >
          <RiRestartLine />
        </Button>
      )}
    </MessageFooter>
  )
}
