/**
 * 删除一个会话文件。
 *
 * pi 把会话和它的 subagent 分两处放：`<时间>_<uuid>.jsonl` 是主会话，
 * 同名的 `<时间>_<uuid>/` 目录里是它派生出来的 subagent 运行记录。删主会话时
 * 两者一起删，否则留下的是再也打不开的孤儿目录。
 *
 * 只接受调用方已经定位好的、位于扫描根目录内的 `.jsonl` 路径：这里不再解释
 * 任何用户输入，也因此不会顺着 `..` 或符号链接删到根目录以外。
 */
import { rm, stat } from 'node:fs/promises'
import { sep } from 'node:path'

const isDirectory = async (path) => {
  const info = await stat(path).catch(() => null)
  return info?.isDirectory() === true
}

/**
 * 返回 `{ removed }` 与删除掉的路径；路径不在根目录内、不是 `.jsonl` 或文件
 * 已不存在时返回 `{ error: [status, message] }`。
 */
export async function deleteSessionFile({ path, root }) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (typeof path !== 'string' || !path.startsWith(prefix)) {
    return { error: [400, '会话文件不在当前根目录内'] }
  }
  if (!path.endsWith('.jsonl')) {
    return { error: [400, '只能删除 .jsonl 会话文件'] }
  }
  const info = await stat(path).catch(() => null)
  if (!info) return { error: [404, '会话文件已不存在'] }
  if (!info.isFile()) return { error: [400, '不是普通文件'] }

  const removed = []
  await rm(path)
  removed.push(path)

  const subagentDir = path.slice(0, -'.jsonl'.length)
  if (subagentDir.length > prefix.length && (await isDirectory(subagentDir))) {
    await rm(subagentDir, { recursive: true, force: true })
    removed.push(subagentDir)
  }

  return { removed }
}
