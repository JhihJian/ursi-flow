import { describe, expect, it } from 'vitest'
import {
  appendModelToEntry,
  diffDiscovered,
  filterModels,
  modelIdOf,
  modelsOf,
  removeModelFromEntry,
} from './models-discover-helpers'

const m = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra })

describe('modelsOf', () => {
  it('数组形态：过滤非对象项', () => {
    const entry = { models: [m('a'), null, 'bad', { noId: true }] }
    expect(modelsOf(entry)).toEqual([m('a'), { noId: true }])
  })

  it('对象映射形态：键合并为 id', () => {
    const entry = { models: { a: { contextWindow: 1 }, b: {} } }
    expect(modelsOf(entry).map(modelIdOf)).toEqual(['a', 'b'])
    expect(modelsOf(entry)[0]).toEqual({ id: 'a', contextWindow: 1 })
  })

  it('没有 models 键时返回空', () => {
    expect(modelsOf({})).toEqual([])
  })
})

describe('diffDiscovered', () => {
  it('按 id 找出缺失，跳过缺 id 与上游重复项', () => {
    const discovered = [m('a'), m(''), m('b'), m('b', { dup: true }), { noId: 1 }]
    const diff = diffDiscovered(discovered, [m('a')])
    expect(diff.missing.map(modelIdOf)).toEqual(['b'])
    expect(diff.existingIds.has('a')).toBe(true)
  })

  it('草稿里缺 id 的项不影响缺失判定', () => {
    const diff = diffDiscovered([m('x')], [{ noId: true }])
    expect(diff.missing.map(modelIdOf)).toEqual(['x'])
  })
})

describe('filterModels', () => {
  it('按 id 或 name 过滤，空查询原样返回', () => {
    const models = [m('glm-5.3', { name: 'GLM' }), m('deepseek', { name: 'DS' })]
    expect(filterModels(models, ' glm ').map(modelIdOf)).toEqual(['glm-5.3'])
    expect(filterModels(models, 'ds').map(modelIdOf)).toEqual(['deepseek'])
    expect(filterModels(models, '  ')).toBe(models)
  })
})

describe('appendModelToEntry / removeModelFromEntry', () => {
  it('追加进数组形态草稿', () => {
    const entry = { baseUrl: 'x', models: [m('a')] }
    const next = appendModelToEntry(entry, m('b', { reasoning: true }))
    expect(modelsOf(next).map(modelIdOf)).toEqual(['a', 'b'])
    expect(entry.models).toHaveLength(1) // 原条目不变
  })

  it('追加进对象映射形态会规整成数组', () => {
    const entry = { models: { a: {} } }
    const next = appendModelToEntry(entry, m('b'))
    expect(Array.isArray(next.models)).toBe(true)
    expect(modelsOf(next).map(modelIdOf)).toEqual(['a', 'b'])
  })

  it('按序号删除，越界原样返回', () => {
    const entry = { models: [m('a'), m('b'), m('c')] }
    expect(modelsOf(removeModelFromEntry(entry, 1)).map(modelIdOf)).toEqual(['a', 'c'])
    expect(removeModelFromEntry(entry, 9)).toBe(entry)
  })
})
