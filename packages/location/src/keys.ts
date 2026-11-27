/**
 * 持久化键：规范 URI 的 sha256 前 16 个 hex。
 *
 * 与 index.ts 分开出口，因为它是 Node 侧能力（依赖 node:crypto），
 * 而 index.ts 要保持纯浏览器可用。跨进程稳定，算法与 fs-web、pi-web 现有的 realpath 哈希一致。
 */

import type { Location } from './index.ts'

/** 求位置的持久化键。 */
export async function keyOf(loc: Location): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(loc.uri).digest('hex').slice(0, 16)
}
