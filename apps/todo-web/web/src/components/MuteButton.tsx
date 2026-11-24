import { useState } from 'react'
import { readMuted, writeMuted } from '@/lib/notifications'

export function MuteButton() {
  const [muted, setMuted] = useState(readMuted)

  return (
    <button
      type="button"
      className={muted ? 'mute-btn muted' : 'mute-btn'}
      title="Toggle sound notification"
      onClick={() => {
        const next = !muted
        setMuted(next)
        writeMuted(next)
      }}
    >
      <span className="mute-icon">{muted ? '🔇' : '🔊'}</span>
    </button>
  )
}
