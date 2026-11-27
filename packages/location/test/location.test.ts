import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import {
  LocationError,
  basename,
  build,
  childOf,
  crumbs,
  equals,
  isWithin,
  keyOf,
  parentOf,
  parse,
  pathSegmentsOf,
  sameDevice,
} from '../src/index.ts'

interface Vectors {
  parse: { input: string; uri: string; scheme: string; device: string | null; path: string }[]
  parseWithHome: { input: string; home: string; uri: string; scheme: string; device: string | null; path: string }[]
  reject: { input: string; code: string }[]
  build: { scheme: string; path: string; device?: string; uri: string }[]
  parent: { uri: string; parent: string | null }[]
  child: { uri: string; name: string; child: string }[]
  basename: { uri: string; basename: string }[]
  within: { root: string; child: string; within: boolean }[]
  keys: { uri: string }[]
}

const vectors = JSON.parse(
  readFileSync(new URL('../vectors.json', import.meta.url), 'utf8'),
) as Vectors

test('parse 向量', () => {
  for (const vector of vectors.parse) {
    const loc = parse(vector.input)
    assert.deepEqual(
      { uri: loc.uri, scheme: loc.scheme, device: loc.device, path: loc.path },
      { uri: vector.uri, scheme: vector.scheme, device: vector.device, path: vector.path },
      vector.input,
    )
  }
})

test('parse 带 home 的向量', () => {
  for (const vector of vectors.parseWithHome) {
    const loc = parse(vector.input, { home: vector.home })
    assert.deepEqual(
      { uri: loc.uri, scheme: loc.scheme, device: loc.device, path: loc.path },
      { uri: vector.uri, scheme: vector.scheme, device: vector.device, path: vector.path },
      vector.input,
    )
  }
})

test('parse 拒绝向量', () => {
  for (const vector of vectors.reject) {
    assert.throws(
      () => parse(vector.input),
      (error: unknown) => (error as { code?: string }).code === vector.code,
      vector.input,
    )
  }
})

test('build 向量', () => {
  for (const vector of vectors.build) {
    const loc = vector.scheme === 'ssh' ? build('ssh', vector.device!, vector.path) : build('file', vector.path)
    assert.equal(loc.uri, vector.uri, JSON.stringify(vector))
  }
})

test('parentOf 向量', () => {
  for (const vector of vectors.parent) {
    const parent = parentOf(parse(vector.uri))
    assert.equal(parent?.uri ?? null, vector.parent, vector.uri)
  }
})

test('childOf 向量', () => {
  for (const vector of vectors.child) {
    assert.equal(childOf(parse(vector.uri), vector.name).uri, vector.child, vector.uri)
  }
})

test('basename 向量', () => {
  for (const vector of vectors.basename) {
    assert.equal(basename(parse(vector.uri)), vector.basename, vector.uri)
  }
})

test('isWithin 向量', () => {
  for (const vector of vectors.within) {
    assert.equal(isWithin(parse(vector.root), parse(vector.child)), vector.within, `${vector.root} ⊇ ${vector.child}`)
  }
})

test('keyOf 稳定且区分大小写', async () => {
  const seen = new Map<string, string>()
  for (const vector of vectors.keys) {
    const key = await keyOf(parse(vector.uri))
    assert.match(key, /^[0-9a-f]{16}$/)
    assert.equal(key, await keyOf(parse(vector.uri)), '同一 URI 两次求键必须一致')
    seen.set(vector.uri, key)
  }
  assert.notEqual(seen.get('ssh://nm105/srv/proj'), seen.get('ssh://NM105/srv/proj'))
})

test('parse 与 build 互逆', () => {
  for (const vector of vectors.build) {
    assert.equal(parse(vector.uri).uri, vector.uri)
  }
})

test('crumbs 逐段累积并保留设备', () => {
  const loc = parse('ssh://nm105/srv/proj')
  assert.deepEqual(
    crumbs(loc).map((crumb) => [crumb.name, crumb.loc.uri]),
    [
      ['srv', 'ssh://nm105/srv'],
      ['proj', 'ssh://nm105/srv/proj'],
    ],
  )
  assert.deepEqual(pathSegmentsOf(parse('file:///')), [])
  assert.deepEqual(pathSegmentsOf(parse('file:///a/b')), ['a', 'b'])
})

test('sameDevice 与 equals', () => {
  assert.equal(sameDevice(parse('ssh://nm105/a'), parse('ssh://nm105/b')), true)
  assert.equal(sameDevice(parse('ssh://nm105/a'), parse('ssh://NM105/b')), false)
  assert.equal(sameDevice(parse('file:///a'), parse('file:///b')), true)
  assert.equal(sameDevice(parse('file:///a'), parse('ssh://nm105/a')), false)
  assert.equal(equals(parse('ssh://nm105/a'), parse('ssh://nm105/a')), true)
})

test('childOf 拒绝多段与上跳', () => {
  for (const name of ['a/b', '..', '.', '', 'a\0b']) {
    assert.throws(() => childOf(parse('file:///x'), name), LocationError, JSON.stringify(name))
  }
})

test('build 拒绝相对路径与非法设备名', () => {
  assert.throws(() => build('file', 'relative'), /绝对路径/)
  assert.throws(() => build('ssh', 'user@host', '/x'), /设备名非法/)
})
