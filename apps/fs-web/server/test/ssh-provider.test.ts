import test from 'node:test'
import assert from 'node:assert/strict'
import { createSshProvider } from '../src/ssh-provider.ts'
import { ProviderError } from '../src/local-provider.ts'
import { parse } from '@ursi/location'

/**
 * 远程 provider 的端到端验证：需要一台能免密 ssh 到达的设备，用 FS_WEB_TEST_SSH_DEVICE 指定
 * （如 `nm105`）。不设置则整组跳过，CI 与离线开发不受影响。
 * 通过 fetchArgs 直接给 ssh 参数，不依赖 ssh-web 在线；ssh-args 端点由 ssh-web 自己的测试覆盖。
 */
const device = process.env.FS_WEB_TEST_SSH_DEVICE
const SKIP = device ? false : '未设置 FS_WEB_TEST_SSH_DEVICE'

const provider = createSshProvider({
  api: 'http://unused.invalid',
  fetchArgs: async (name) => {
    if (name !== device) throw new ProviderError('device_not_found', 404, `没有连接：${name}`)
    return [name]
  },
})

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
    return 'ok'
  } catch (error) {
    return error instanceof ProviderError ? error.code : String(error)
  }
}

test(
  '远程目录：全流程与越界防护',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const base = `/tmp/fs-web-ssh-test-${process.pid}`
    const run = (script: string) =>
      new Promise<string>((resolve, reject) => {
        import('node:child_process').then(({ execFile }) =>
          execFile('ssh', ['-o', 'BatchMode=yes', device!, script], (error, stdout, stderr) =>
            error ? reject(new Error(stderr || error.message)) : resolve(stdout),
          ),
        )
      })
    await run(`rm -rf ${base} && mkdir -p ${base}`)
    try {
      const root = parse(`ssh://${device}${base}`)

      // realize 返回规范位置，根目录名保留。
      const realized = await provider.realize(root.uri)
      assert.equal(realized.uri, root.uri)

      // 初始为空目录；父目录是 /tmp（只有设备根的 parent 才是 null）。
      const browsed = await provider.browse(root.uri)
      assert.equal(browsed.location.uri, realized.uri)
      assert.equal(browsed.parent?.uri, `ssh://${device}/tmp`)
      assert.deepEqual(browsed.entries, [])

      // 写、读、stat 往返；内容含中文与换行，验证 base64 传输不改写。
      const written = await provider.write({ id: 't', provider: 'ssh', root: root.uri }, ['中文 文件.txt'], '你好\nworld\n', { overwrite: true })
      assert.ok(written.mtime > 0)
      const read = await provider.read({ id: 't', provider: 'ssh', root: root.uri }, ['中文 文件.txt'])
      assert.equal(read.content, '你好\nworld\n')
      assert.equal(read.size, Buffer.byteLength('你好\nworld\n'))
      const stat = await provider.stat({ id: 't', provider: 'ssh', root: root.uri }, ['中文 文件.txt'])
      assert.equal(stat.type, 'file')

      // list：目录优先，再按名排序。
      await provider.mkdir({ id: 't', provider: 'ssh', root: root.uri }, ['zdir'])
      const list = await provider.list({ id: 't', provider: 'ssh', root: root.uri }, [])
      assert.deepEqual(
        list.map((entry) => [entry.name, entry.type]),
        [
          ['zdir', 'dir'],
          ['中文 文件.txt', 'file'],
        ],
      )

      // browse 只列子目录。
      assert.deepEqual((await provider.browse(root.uri)).entries, [{ name: 'zdir' }])

      // 乐观锁：不带 expectMtime 且文件存在 → conflict；带正确 mtime → 成功。
      const ws = { id: 't', provider: 'ssh' as const, root: root.uri }
      assert.equal(await codeOf(() => provider.write(ws, ['中文 文件.txt'], 'x', { overwrite: false })), 'conflict')
      const rewritten = await provider.write(ws, ['中文 文件.txt'], 'v2', { expectMtime: read.mtime })
      assert.ok(rewritten.mtime >= read.mtime)
      assert.equal((await provider.read(ws, ['中文 文件.txt'])).content, 'v2')

      // rename 与 delete。
      const renamed = await provider.rename(ws, ['中文 文件.txt'], 'renamed.txt')
      assert.equal(renamed.name, 'renamed.txt')
      assert.equal(await codeOf(() => provider.read(ws, ['中文 文件.txt'])), 'not_found')
      await provider.delete(ws, ['renamed.txt'])
      await provider.delete(ws, ['zdir'])
      assert.deepEqual(await provider.list(ws, []), [])

      // 越界：.. 段、根之外的目标、指向根外的符号链接都被拒绝。
      assert.equal(await codeOf(() => provider.list(ws, ['..'])), 'bad_request')
      await run(`ln -s /etc ${base}/escape`)
      assert.equal(await codeOf(() => provider.list(ws, ['escape'])), 'path_outside_root')
      assert.equal(await codeOf(() => provider.read(ws, ['escape', 'hostname'])), 'path_outside_root')

      // 不存在的路径与未知设备。
      assert.equal(await codeOf(() => provider.read(ws, ['nope'])), 'not_found')
      assert.equal(await codeOf(() => provider.realize('ssh://no-such-device/x')), 'device_not_found')

      // git 不实现。
      assert.equal(provider.gitStatus, undefined)
    } finally {
      await run(`rm -rf ${base}`)
    }
  },
)
