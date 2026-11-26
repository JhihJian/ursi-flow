/**
 * 标签颜色：把标签名哈希到固定色相，再套一套统一的饱和度与明度。
 * 颜色只由标签名决定，同一标签在任何时候、任何视图里都是同一个颜色。
 */
export function tagColor(tag: string): string {
  let hash = 5381
  for (let i = 0; i < tag.length; i += 1) {
    hash = (Math.imul(hash, 33) ^ tag.charCodeAt(i)) >>> 0
  }
  const hue = hash % 360
  return `hsl(${hue}, 48%, 46%)`
}
