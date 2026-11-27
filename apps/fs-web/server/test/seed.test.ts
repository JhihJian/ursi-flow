import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseWorkspaceSeed, ProviderError } from '../src/local-provider.ts'

test('种子接受 file 与 ssh 位置，provider 跟随 root 的 scheme', () => {
  const local = parseWorkspaceSeed({ id: 'a', root: '/data/dev' }, 't')
  assert.equal(local.provider, 'file')
  assert.equal(local.root, 'file:///data/dev')

  const ssh = parseWorkspaceSeed({ id: 'b', root: 'ssh://nm105/srv/proj' }, 't')
  assert.equal(ssh.provider, 'ssh')
  assert.equal(ssh.root, 'ssh://nm105/srv/proj')

  // 裸路径简写与 ~ 在服务端展开。
  assert.equal(parseWorkspaceSeed({ id: 'c', root: '~/x' }, 't').root, `file://${os.homedir()}/x`)
})

test('种子拒绝 provider 与 root 不一致、非法位置、非法 provider', () => {
  const throws = (item: unknown, pattern: RegExp) =>
    assert.throws(() => parseWorkspaceSeed(item, 't'), pattern)

  throws({ id: 'a', provider: 'ssh', root: '/data' }, /provider 与 root 不一致/)
  throws({ id: 'a', provider: 'file', root: 'ssh://nm105/srv' }, /provider 与 root 不一致/)
  throws({ id: 'a', provider: 'local', root: '/data' }, /provider 与 root 不一致/)
  throws({ id: 'a', provider: 'ftp', root: '/data' }, /provider 与 root 不一致/)
  throws({ id: 'a', root: 'relative' }, /不是合法位置/)
  throws({ id: 'a', root: 'ssh://user@host/x' }, /不是合法位置/)
  throws({ id: 'A', root: '/data' }, /id 非法/)
})

test('ProviderError 携带 code 与 status，供 HTTP 层直接映射', () => {
  const error = new ProviderError('path_outside_root', 403, 'x')
  assert.equal(error.code, 'path_outside_root')
  assert.equal(error.status, 403)
  assert.ok(error instanceof Error)
})
