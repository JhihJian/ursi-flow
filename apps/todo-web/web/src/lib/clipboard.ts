/**
 * 复制文本。局域网用 http 打开时不是安全上下文，`navigator.clipboard` 不存在，
 * 这时退回一次性的 textarea 加 `execCommand('copy')`。
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }

  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  area.setSelectionRange(0, text.length)
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    document.body.removeChild(area)
  }
  if (!copied) throw new Error('Clipboard is not available')
}
