import { describe, expect, test } from 'vitest'
import { classifyInput, filterEntries, joinPath, pathSegments } from './path'
import type { DirEntry } from './types'

describe('joinPath', () => {
  test('根目录直接拼，其他目录用 / 连接', () => {
    expect(joinPath('/', 'data')).toBe('/data')
    expect(joinPath('/data', 'dev')).toBe('/data/dev')
  })
})

describe('classifyInput', () => {
  test('含斜杠或 ~ . .. 当路径', () => {
    expect(classifyInput('/data')).toBe('path')
    expect(classifyInput('dev/')).toBe('path')
    expect(classifyInput('~')).toBe('path')
    expect(classifyInput('~/work')).toBe('path')
    expect(classifyInput('.')).toBe('path')
    expect(classifyInput('..')).toBe('path')
  })
  test('纯文字当过滤词', () => {
    expect(classifyInput('dev')).toBe('filter')
    expect(classifyInput('')).toBe('filter')
    expect(classifyInput('ursi flow')).toBe('filter')
  })
})

describe('filterEntries', () => {
  const entries: DirEntry[] = [{ name: 'Data' }, { name: 'usr' }, { name: 'data-dev' }]

  test('空过滤返回全部（同一引用，方便调用方做恒等判断）', () => {
    expect(filterEntries(entries, '')).toBe(entries)
    expect(filterEntries(entries, '  ')).toBe(entries)
  })
  test('大小写不敏感子串匹配，不改顺序', () => {
    expect(filterEntries(entries, 'data').map((entry) => entry.name)).toEqual(['Data', 'data-dev'])
    expect(filterEntries(entries, 'DEV').map((entry) => entry.name)).toEqual(['data-dev'])
  })
})

describe('pathSegments', () => {
  test('根为空，多级路径逐段累积', () => {
    expect(pathSegments('/')).toEqual([])
    expect(pathSegments('/data/dev')).toEqual([
      { name: 'data', path: '/data' },
      { name: 'dev', path: '/data/dev' },
    ])
  })
})
