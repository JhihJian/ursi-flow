/**
 * 证据写入。断言证据落在 web/acceptance/evidence/，不写入令牌与私有材料。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { evidenceDir } from './runtime'

export function writeEvidence(name: string, body: unknown) {
  mkdirSync(evidenceDir, { recursive: true })
  const file = path.join(evidenceDir, name)
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n')
  return file
}

export interface ModelRequest {
  at: string
  model: string | null
  stream: boolean | null
  messages: Array<{ role: string; content: string }>
}

/** 读取模拟模型端点记录的请求；文件缺失时返回空数组。 */
export function readModelRequests(file: string): ModelRequest[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ModelRequest)
  } catch {
    return []
  }
}

export function userText(request: ModelRequest) {
  return request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
}

/**
 * 用户消息摘要：只保留验收需要区分的要素，用于报告取证。
 * 材料是本次运行生成的工单编号和固定提示词，不含令牌与私有数据。
 */
export function summarizeUserMessage(content: string) {
  const tickets = content.match(/ticket-[A-Za-z0-9-]+/g) ?? []
  const prompts = content.match(/PROMPT-[A-Za-z0-9-]+/g) ?? []
  const sops = content.match(/SOP-[A-Za-z0-9-]+/g) ?? []
  return {
    chars: content.length,
    tickets: Array.from(new Set(tickets)).sort(),
    prompts: Array.from(new Set(prompts)).sort(),
    sops: Array.from(new Set(sops)).sort(),
  }
}
