import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { evidenceDir } from './paths'

/** 写一份断言证据。令牌、Cookie 和完整私有材料不写入证据。 */
export function writeEvidence(name: string, body: Record<string, unknown>) {
  mkdirSync(evidenceDir, { recursive: true })
  const file = path.join(evidenceDir, `${name}.json`)
  writeFileSync(file, JSON.stringify(body, null, 2))
  return file
}

/** 材料正文的摘要，用于证据比对而不落原文。 */
export function digest(text: string) {
  return Buffer.from(text, 'utf8').toString('base64url')
}
