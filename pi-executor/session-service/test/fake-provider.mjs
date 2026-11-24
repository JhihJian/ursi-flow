import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

export const model = 'local-fake';
export const modelKey = 'fake-model-key';

export async function fakeProvider({ autoFinish = false } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${modelKey}`) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const content = body.messages.filter(message => message.role === 'user').at(-1)?.content;
    const text = Array.isArray(content) ? content.map(block => block.text ?? '').join('') : content;
    const request = { body, closed: false };
    requests.push(request);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    request.finish = release;
    res.on('close', () => { request.closed = true; release(); });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => {
      const frame = { object: 'chat.completion.chunk', id: `fake-${requests.length}`, model, choices: [{ index: 0, delta, finish_reason }] };
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    const toolUsed = body.messages.some(message => message.role === 'tool');
    if (typeof text === 'string' && text.includes('use reference') && !toolUsed) {
      chunk({ tool_calls: [{ index: 0, id: 'fake_ref', type: 'function', function: { name: 'read_reference', arguments: '{}' } }] });
      chunk({}, 'tool_calls');
      res.end('data: [DONE]\n\n');
      return;
    }
    chunk({ content: '第一段输出。' });
    if (autoFinish) await sleep(2200);
    else await gate;
    if (!res.destroyed) {
      chunk({ content: '第二段输出。' });
      chunk({}, 'stop');
      res.end('data: [DONE]\n\n');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, requests,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
