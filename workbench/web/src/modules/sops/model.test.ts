import { expect, it } from 'vitest'
import { findVersion, groupVersions, latestOf, validateDraft, type SopVersion } from './model'

const version = (id: string, revision: number, title = '回执'): SopVersion => ({
  id, revision, executor: 'echo', config: { title },
})

it('按标识分组并按修订倒序排列', () => {
  const groups = groupVersions([version('b', 1), version('a', 1), version('a', 3), version('a', 2)])
  expect(groups.map(group => [group.id, group.latest.revision, group.versions.map(v => v.revision)]))
    .toEqual([['a', 3, [3, 2, 1]], ['b', 1, [1]]])
  expect(groups[0]!.title).toBe('回执')
})

it('按标识和数值修订查找，非法修订不匹配', () => {
  const versions = [version('receipt', 1), version('receipt', 2, '交接记录')]
  expect(findVersion(versions, 'receipt', '2')?.config.title).toBe('交接记录')
  expect(findVersion(versions, 'receipt', 9)).toBeUndefined()
  expect(findVersion(versions, 'receipt', 'x')).toBeUndefined()
  expect(latestOf(versions, 'receipt')?.revision).toBe(2)
  expect(latestOf(versions, 'missing')).toBeUndefined()
})

it('校验标识格式、标题非空、单行和 256 字节上限', () => {
  expect(validateDraft('', '回执')).toContain('SOP 标识')
  expect(validateDraft('bad id', '回执')).toContain('SOP 标识')
  expect(validateDraft('a'.repeat(81), '回执')).toContain('SOP 标识')
  expect(validateDraft('receipt', '   ')).toContain('回执标题')
  expect(validateDraft('receipt', '第一行\n第二行')).toContain('单行')
  expect(validateDraft('receipt', '回'.repeat(85))).toBe('')
  expect(validateDraft('receipt', '回'.repeat(86))).toContain('256')
})
