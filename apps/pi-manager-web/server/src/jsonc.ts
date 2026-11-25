/**
 * JSONC 读取：与 pi 的 models.json 加载器同样宽松（剥 BOM、剥 // 与斜块注释）。
 *
 * 写入语义（与 pi CLI 一致）：序列化输出纯 JSON，原有注释不保留。
 * .bak-manager 备份是注释可找回的唯一途径，SPEC 与 UI 都明示这一点。
 */

export function stripJsonComments(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  let out = ''
  let i = 0
  const n = noBom.length
  while (i < n) {
    const ch = noBom[i]
    if (ch === '"') {
      // 字符串原样复制，转义跳过。
      out += ch
      i += 1
      while (i < n) {
        const c = noBom[i]
        out += c
        i += 1
        if (c === '\\') {
          if (i < n) {
            out += noBom[i]
            i += 1
          }
        } else if (c === '"') {
          break
        }
      }
      continue
    }
    if (ch === '/' && noBom[i + 1] === '/') {
      while (i < n && noBom[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && noBom[i + 1] === '*') {
      i += 2
      while (i < n && !(noBom[i] === '*' && noBom[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

export function parseJsonc<T>(text: string): T {
  const trimmed = stripJsonComments(text).trim()
  if (!trimmed) return {} as T
  return JSON.parse(trimmed) as T
}
