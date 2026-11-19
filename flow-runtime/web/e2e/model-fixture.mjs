// 端到端验收用的 OpenAI 兼容模型：按节点提示词提交该节点允许的结果。
// 分析节点只接受「已分析」，完成节点只接受「已完成」，模型不能越权提交别节点的结果。
import { createServer } from 'node:http'

const port = Number(process.env.MODEL_FIXTURE_PORT || 14485)
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  const prompt = [...(body.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'user')
  const content = prompt?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((block) => block?.text ?? '').join('\n')
        : ''
  // 节点提示词会列出允许的结果名，按声明提交，避免越权。
  const args = { outcome: /[-•]\s*已完成\s*[:：]/.test(text) ? '已完成' : '已分析' }
  const delta = {
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id: `call_${Date.now()}`,
        type: 'function',
        function: { name: 'submit_flow_outcome', arguments: JSON.stringify(args) },
      },
    ],
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [chunk, stop] of [
    [delta, null],
    [{}, 'tool_calls'],
  ])
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'completion_fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'e2e-fixture',
          choices: [{ index: 0, delta: chunk, finish_reason: stop }],
        }) +
        '\n\n',
    )
  res.end('data: [DONE]\n\n')
})
server.listen(port, '127.0.0.1', () => process.stdout.write(`模型 fixture: ${port}\n`))
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)))
