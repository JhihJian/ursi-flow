import type http from 'node:http'

/** 回环地址判定：IPv4 映射地址先剥掉前缀。 */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.')
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

export function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } })
}

export async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > limit) throw new Error(`请求体超过 ${limit} 字节`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
