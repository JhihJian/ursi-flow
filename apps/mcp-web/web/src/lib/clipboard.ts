/**
 * 复制纯文本。`navigator.clipboard` 只在安全上下文可用，用局域网 HTTP 打开
 * 工作台时它是 undefined，因此先尝试异步剪贴板，失败后退回选中文本复制。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被拒或页面失焦继续走兜底，不把异常抛给调用方。
  }
  return copyWithSelection(text)
}

/** 只支持兜底实现时使用：靠临时只读文本域取得选区后复制。 */
function copyWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  // 固定定位并隐藏，避免复制时页面跳动或出现在可视区。
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  area.setSelectionRange(0, text.length)
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}
