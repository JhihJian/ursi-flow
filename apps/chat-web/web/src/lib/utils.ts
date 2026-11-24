// 只允许 http(s) 链接进入 href，防止不可信的模型/工具输出注入
// javascript: 或 data: 协议。
export function safeHttpUrl(url: string): string | undefined {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}
