/**
 * 把磁盘上的会话行转换成轨迹组件库能解析的标准形状。
 *
 * 组件库（pi-agent-trajectory-viewer）要求首行 `type: "session"`、消息行是
 * `type: "message"` 且带 `message.role`。目录里同时存在老写法（`type: user|assistant`、
 * `uuid/parentUuid`、没有 session 头），这里统一补齐并映射，未知类型原样保留（库会忽略）。
 *
 * 与 `session-viewer/server/src/canonicalize.mjs` 同一份规则：两处都要能独立渲染
 * 同一批会话文件，规则分叉会导致同一个会话在两个页面里长得不一样。
 */

export function detectFormat(row) {
  if (!row || typeof row !== 'object') return 'unknown'
  if (row.type === 'session') return 'pi'
  if ((row.type === 'user' || row.type === 'assistant') && row.message?.role) return 'legacy'
  return 'unknown'
}

const isMessageRow = (row) =>
  (row.type === 'user' || row.type === 'assistant') && row.message && typeof row.message === 'object'

/**
 * 逐行转换。`transform` 返回要写出的行（可能为空），无法解析的行被丢弃并计数，
 * 这样组件库不会因为一行坏数据整份拒绝。
 */
export function createTransformer(meta) {
  let headerWritten = false
  let previousId = null
  let sequence = 0
  let skipped = 0

  const header = (source = {}) =>
    JSON.stringify({
      type: 'session',
      version: 3,
      id: typeof source.sessionId === 'string' ? source.sessionId : meta.sessionId,
      timestamp: source.timestamp ?? meta.timestamp,
      cwd: typeof source.cwd === 'string' ? source.cwd : (meta.project ?? null),
    })

  return {
    get skipped() {
      return skipped
    },
    transform(line) {
      const text = line.trim()
      if (!text) return []

      let row
      try {
        row = JSON.parse(text)
      } catch {
        skipped += 1
        return []
      }
      if (!row || typeof row !== 'object') {
        skipped += 1
        return []
      }

      if (row.type === 'session') {
        if (headerWritten) return []
        headerWritten = true
        return [header(row)]
      }

      const output = []
      if (!headerWritten) {
        headerWritten = true
        output.push(header(row))
      }

      sequence += 1

      if (isMessageRow(row)) {
        // 老写法自带 uuid/parentUuid，直接沿用来保住分支链；没有就按顺序串起来。
        const id = typeof row.uuid === 'string' ? row.uuid : `entry-${sequence}`
        const parentId =
          typeof row.parentUuid === 'string'
            ? row.parentUuid
            : typeof row.parentId === 'string'
              ? row.parentId
              : previousId
        previousId = id
        output.push(
          JSON.stringify({
            type: 'message',
            id,
            parentId,
            timestamp: row.timestamp ?? null,
            message: { role: row.message.role ?? row.type, content: row.message.content ?? [] },
          }),
        )
        return output
      }

      output.push(JSON.stringify(row))
      return output
    },
  }
}
