import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createPi } from './pi.mjs';
import { createSessions, RequestError, sessionId } from './sessions.mjs';

const api = '/api/pi';
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json'], ['.txt', 'text/plain; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'],
  ['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ico', 'image/x-icon'],
]);
const hash = text => createHash('sha256').update(text).digest();
const inside = (root, file) => {
  const path = relative(root, file);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req, key, { optional = false } = {}) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new RequestError(415, '需要 JSON 请求');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 64 * 1024) { req.resume(); throw new RequestError(413, '请求过长'); }
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'JSON 无效'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== key)) {
    throw new RequestError(400, '请求字段无效');
  }
  if (optional && !(key in input)) return '';
  const limit = optional ? 100 : 16_000;
  const value = typeof input[key] === 'string' ? input[key].trim() : '';
  if (!value || value.length > limit) throw new RequestError(400, `${key} 无效`);
  return value;
}

async function staticFile(req, res, url, root) {
  if (!root || !['GET', 'HEAD'].includes(req.method)) throw new RequestError(404, '页面不存在');
  const path = decodeURIComponent(url.pathname);
  if (path.split('/').some(segment => segment.startsWith('.'))) throw new RequestError(404, '页面不存在');
  const candidate = resolve(root, `.${path}${path.endsWith('/') ? 'index.html' : ''}`);
  const file = await realpath(candidate).catch(error => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new RequestError(404, '页面不存在');
    throw error;
  });
  if (!inside(root, file)) throw new RequestError(404, '页面不存在');
  const info = await stat(file);
  if (!info.isFile()) throw new RequestError(404, '页面不存在');
  res.writeHead(200, { 'content-type': mime.get(extname(file)) ?? 'application/octet-stream', 'content-length': info.size });
  if (req.method === 'HEAD') res.end();
  else await pipeline(createReadStream(file), res);
}

export async function startService(env = process.env) {
  function required(name) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  }
  const writeToken = required('PI_SESSION_WRITE_TOKEN');
  const readToken = required('PI_SESSION_READ_TOKEN');
  if (writeToken.length < 24 || readToken.length < 24 || writeToken === readToken) throw new Error('Use distinct session tokens of at least 24 characters');
  const writers = hash(writeToken);
  const readers = hash(readToken);
  const apiKey = required('PI_SESSION_MODEL_KEY');
  const modelId = required('PI_SESSION_MODEL');
  const modelUrl = new URL(required('PI_SESSION_MODEL_URL'));
  if (!['http:', 'https:'].includes(modelUrl.protocol) || modelUrl.username || modelUrl.password) throw new Error('Invalid model URL');
  const directory = required('PI_SESSION_STATE_DIR');
  if (!isAbsolute(directory)) throw new Error('PI_SESSION_STATE_DIR must be absolute');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const root = await realpath(directory);
  const info = await stat(root);
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Use a private session state directory owned by the service');
  const web = env.PI_SESSION_WEB_DIR ? await realpath(env.PI_SESSION_WEB_DIR) : null;
  if (web && (inside(web, root) || inside(root, web))) throw new Error('Keep the web build and private session state in separate directories');
  const lock = join(root, '.session-owner');
  await mkdir(lock, { mode: 0o700 });
  try {
    return await listen();
  } catch (error) {
    await rm(lock, { recursive: true });
    throw error;
  }

  async function listen() {
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { mode: 0o700, recursive: true });
    let reference;
    if (env.PI_SESSION_REFERENCE_FILE) {
      const info = await stat(env.PI_SESSION_REFERENCE_FILE);
      if (!info.isFile() || info.size > 12_000) throw new Error('Use a reference text file of at most 12000 bytes');
      reference = await readFile(env.PI_SESSION_REFERENCE_FILE, 'utf8');
    }
    const openPi = await createPi({ root, cwd, modelId, baseUrl: modelUrl.href, apiKey, reference });
    const sessions = createSessions({ root, cwd, openPi, apiKey });
    await sessions.restore();
    const streamClosers = new Set();
    let closing = false;
    let closePromise;
    const server = createServer(async (req, res) => {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', "img-src 'self' data: blob:; frame-ancestors 'self'");
      try {
        const url = new URL(req.url, 'http://localhost');
        if (!(url.pathname === api || url.pathname.startsWith(`${api}/`))) return await staticFile(req, res, url, web);
        if (closing) throw new RequestError(503, '会话服务正在关闭');
        const auth = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
        if (!auth) throw new RequestError(401, '需要会话令牌');
        const key = hash(auth);
        const canWrite = timingSafeEqual(key, writers);
        if (!canWrite && !timingSafeEqual(key, readers)) throw new RequestError(401, '会话令牌无效');
        const parts = url.pathname.slice(api.length + 1).split('/');
        const [resource, id, action] = parts;
        if (resource === 'access' && parts.length === 1 && req.method === 'GET') return json(res, 200, { canWrite });
        if (resource !== 'sessions' || parts.length > 3 || (parts.length > 1 && !sessionId.test(id))) throw new RequestError(404, '接口不存在');
        if (req.method === 'GET') {
          if (parts.length === 1) return json(res, 200, { sessions: sessions.list() });
          if (action === 'events') return await stream(id, res);
          if (parts.length === 2) return json(res, 200, await sessions.snapshot(id));
        }
        if (req.method === 'POST') {
          if (!canWrite) throw new RequestError(403, '此令牌只允许查看');
          if (parts.length === 1) return json(res, 201, await sessions.create(await body(req, 'title', { optional: true })));
          if (action === 'prompt') return json(res, 202, await sessions.prompt(id, await body(req, 'message')));
          if (action === 'cancel') {
            req.resume();
            if (!sessions.cancel(id)) throw new RequestError(409, '没有正在运行的任务');
            return json(res, 202, { status: 'cancelling' });
          }
        }
        throw new RequestError(404, '接口不存在');
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(); return; }
        if (error instanceof RequestError) return json(res, error.status, { error: error.message });
        if (error instanceof URIError) return json(res, 400, { error: '路径无效' });
        console.error('Pi session request failed:', error.code ?? error.name);
        json(res, 500, { error: '会话服务异常' });
      }
    });

    async function stream(id, res) {
      if (streamClosers.size >= 48) throw new RequestError(429, '观察连接过多');
      const snapshot = await sessions.snapshot(id);
      if (res.destroyed) return;
      if (closing) throw new RequestError(503, '会话服务正在关闭');
      if (streamClosers.size >= 48) throw new RequestError(429, '观察连接过多');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store, no-transform',
        'x-accel-buffering': 'no',
      });
      const lifetime = new AbortController();
      let busy = true;
      let pending = false;
      const write = async data => {
        if (!res.destroyed && !res.write(data)) await once(res, 'drain', { signal: lifetime.signal });
      };
      const frame = data => `data: ${JSON.stringify(data)}\n\n`;
      async function flush(first) {
        try {
          await write(first);
          while (pending && !res.destroyed) {
            pending = false;
            await write(frame(await sessions.snapshot(id)));
          }
        } catch {
          res.destroy();
        } finally {
          busy = false;
        }
      }
      const unsubscribe = sessions.subscribe(id, () => {
        pending = true;
        if (!busy) { busy = true; void flush(''); }
      });
      const heartbeat = setInterval(() => {
        if (!busy && !res.destroyed) { busy = true; void flush(': ping\n\n'); }
      }, 15_000);
      const disconnect = () => res.destroy();
      streamClosers.add(disconnect);
      res.once('close', () => {
        lifetime.abort();
        unsubscribe();
        clearInterval(heartbeat);
        streamClosers.delete(disconnect);
      });
      // A run might have changed during the initial read, before subscribing.
      pending = true;
      void flush(frame(snapshot));
    }

    const host = env.PI_SESSION_HOST || '127.0.0.1';
    const port = Number(env.PI_SESSION_PORT ?? 30146);
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); accept(); });
    });
    return {
      server,
      close() {
        return closePromise ??= (async () => {
          closing = true;
          for (const disconnect of streamClosers) disconnect();
          await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
          await sessions.stop();
          await rm(lock, { recursive: true });
        })();
      },
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const service = await startService();
    const { address, port } = service.server.address();
    console.log(`Pi session service listening on ${address}:${port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close().catch(() => { process.exitCode = 1; }); });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
