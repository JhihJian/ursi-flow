const MUTE_KEY = 'todo-web.notificationMuted'
const SOUND_URL = '/notification.mp3'

export function readMuted(): boolean {
  return localStorage.getItem(MUTE_KEY) === 'true'
}

export function writeMuted(muted: boolean): void {
  localStorage.setItem(MUTE_KEY, String(muted))
}

export async function playNotificationSound(): Promise<void> {
  if (readMuted()) return
  try {
    const audio = new Audio(SOUND_URL)
    audio.volume = 0.5
    await audio.play()
  } catch (error) {
    console.info('Could not play notification sound:', error)
  }
}

export function showDesktopNotification(count: number): void {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  new Notification(count === 1 ? 'Task completed!' : `${count} tasks completed!`, {
    body: 'Click to view details',
  })
}

export async function requestNotificationPermission(): Promise<void> {
  if (!('Notification' in window)) return
  if (Notification.permission === 'default') {
    await Notification.requestPermission()
  }
}
