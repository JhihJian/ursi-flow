import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { localPathOf, uriOf } from '../src/shared/locate.ts'
import { HomeError } from '../src/shared/pi-home.ts'

const codeOf = (fn: () => unknown) => {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof HomeError ? error.code : String(error)
  }
}

test('浏览入口接受 file:// URI、裸路径与 ~ 简写，都归一为裸路径', () => {
  assert.equal(localPathOf('file:///data/dev/x', 'c'), '/data/dev/x')
  assert.equal(localPathOf('/data/dev/x', 'c'), '/data/dev/x')
  assert.equal(localPathOf('file:///data/dev/x/', 'c'), '/data/dev/x')
  assert.equal(localPathOf('~', 'c'), homedir())
  assert.equal(localPathOf('~/dev/x', 'c'), join(homedir(), 'dev/x'))
})

test('浏览入口拒绝空值、相对路径、其它 scheme 与远程位置', () => {
  assert.equal(codeOf(() => localPathOf('', 'c')), 'c')
  assert.equal(codeOf(() => localPathOf('   ', 'c')), 'c')
  assert.equal(codeOf(() => localPathOf('relative/path', 'c')), 'c')
  assert.equal(codeOf(() => localPathOf('ssh://nm105/srv', 'c')), 'c')
  assert.equal(codeOf(() => localPathOf('smb://nas/share', 'c')), 'c')
})

test('uriOf 把裸路径转回位置 URI，特殊字符可逆', () => {
  assert.equal(uriOf('/data/dev/x'), 'file:///data/dev/x')
  assert.equal(uriOf('/home/u/my proj'), 'file:///home/u/my%20proj')
  assert.equal(uriOf('/home/u/中文'), 'file:///home/u/%E4%B8%AD%E6%96%87')
})
