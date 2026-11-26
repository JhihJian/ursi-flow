/**
 * 侧边栏偏好：当前只有「特别关注」的项目列表，顺序就是显示顺序。
 *
 * 与扫描索引分开存：索引随时可以丢弃重建，偏好丢了就是用户的操作丢失。
 * 写盘用临时文件加改名，半个文件不会被下次启动读到；读不动就退回默认值。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const VERSION = 1
/** 最多关注这么多个项目，防止误操作或异常输入把文件撑大。 */
const MAX_PINNED = 100
const MAX_KEY_LENGTH = 4096

export function emptyPrefs() {
  return { version: VERSION, pinnedProjects: [] }
}

function isKey(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_KEY_LENGTH &&
    // `__proto__` 当作键会改掉原型而不是新增一项。
    value !== '__proto__'
  )
}

/** 去掉非法项与重复项，保留首次出现的顺序。 */
export function normalizePinned(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const kept = []
  for (const key of value) {
    if (!isKey(key) || seen.has(key)) continue
    seen.add(key)
    kept.push(key)
    if (kept.length >= MAX_PINNED) break
  }
  return kept
}

/**
 * 一个请求应用后的关注列表。`pin` 与 `unpin` 是项目键；pin 把项目放到最前
 * （最近关注的在最上面），unpin 去掉它。已经是目标状态时不变。
 */
export function applyPinnedChange(
  pinnedProjects: unknown,
  change: { pin?: string; unpin?: string },
) {
  const { pin, unpin } = change
  const current = normalizePinned(pinnedProjects)
  if (isKey(unpin)) return current.filter((key) => key !== unpin)
  if (!isKey(pin)) return current
  return normalizePinned([pin, ...current.filter((key) => key !== pin)])
}

export function createPrefs({ file }) {
  let state = emptyPrefs()

  return {
    get() {
      return { pinnedProjects: [...state.pinnedProjects] }
    },

    async load() {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        state = {
          version: VERSION,
          pinnedProjects: normalizePinned(parsed?.pinnedProjects),
        }
      } catch {
        // 没有偏好文件或内容损坏：从默认值开始
        state = emptyPrefs()
      }
    },

    async save() {
      await mkdir(dirname(file), { recursive: true }).catch(() => undefined)
      const temporary = `${file}.tmp`
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
      renameSync(temporary, file)
    },

    async apply(change) {
      const next = applyPinnedChange(state.pinnedProjects, change)
      const changed = next.length !== state.pinnedProjects.length
        || next.some((key, index) => key !== state.pinnedProjects[index])
      if (changed) {
        state = { version: VERSION, pinnedProjects: next }
        await this.save()
      }
      return { pinnedProjects: [...state.pinnedProjects], changed }
    },
  }
}
