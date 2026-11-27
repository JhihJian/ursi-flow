import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { basename, build, childOf, crumbs, isWithin, keyOf, parentOf, parse, pathSegmentsOf, sameDevice } from '../src/index.ts'

test('keyOf 与 sha256(uri) 前 16 hex 一致', async () => {
  const uri = 'ssh://nm105/srv/proj'
  const expected = createHash('sha256').update(uri).digest('hex').slice(0, 16)
  assert.equal(await keyOf(parse(uri)), expected)
})

test('空格、中文、井号、百分号在 URI 里可逆', () => {
  const loc = build('ssh', 'nm105', "/srv/a b/中文/#x/100%/q?")
  assert.equal(loc.uri, 'ssh://nm105/srv/a%20b/%E4%B8%AD%E6%96%87/%23x/100%25/q%3F')
  assert.equal(parse(loc.uri).path, "/srv/a b/中文/#x/100%/q?")
})

test('不折叠 ..，越界交给 provider', () => {
  assert.equal(parse('file:///a/../b').path, '/a/../b')
})

test('crumbs 在根目录为空', () => {
  assert.deepEqual(crumbs(parse('file:///')), [])
  assert.deepEqual(crumbs(parse('ssh://nm105/')), [])
})

test('isWithin 根目录包含一切同设备位置', () => {
  assert.equal(isWithin(parse('ssh://nm105/'), parse('ssh://nm105/any/where')), true)
})

test('pathSegmentsOf 对编码段已解码', () => {
  assert.deepEqual(pathSegmentsOf(parse('ssh://nm105/a%20b/c')), ['a b', 'c'])
})

test('basename 对根目录返回斜杠', () => {
  assert.equal(basename(parse('file:///')), '/')
  assert.equal(basename(build('ssh', 'nm105', '/')), '/')
})

test('parentOf 保留设备与 scheme', () => {
  const parent = parentOf(parse('ssh://nm105/srv/proj'))
  assert.ok(parent)
  assert.equal(parent.device, 'nm105')
  assert.equal(parent.scheme, 'ssh')
})

test('childOf 在根目录下不产生双斜杠', () => {
  assert.equal(childOf(parse('file:///'), 'data').uri, 'file:///data')
})

test('sameDevice 对 file 恒为真', () => {
  assert.equal(sameDevice(parse('file:///a'), parse('file:///b')), true)
})
