/** 复制文本：优先用 Clipboard API，非安全上下文退回隐藏 textarea。 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'absolute'
  area.style.left = '-9999px'
  document.body.appendChild(area)
  area.select()
  try {
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('浏览器拒绝了复制请求')
  } finally {
    area.remove()
  }
}
