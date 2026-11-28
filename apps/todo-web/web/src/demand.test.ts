import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { check, parse, regionIdsFromSource } from '@demand/core'

/**
 * DEMAND.md 的节与页面上的分区双向一致。
 * 改了分区属性或 DEMAND.md 的任何一边，这里会红。
 */
// 这个文件在 web/src/ 下，DEMAND.md 与 web/ 同级。
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const read = (path: string) => readFileSync(resolve(moduleRoot, path), 'utf8')

test('DEMAND.md 可解析', () => {
  const doc = parse(read('DEMAND.md'))
  expect(doc.title).toBe('SUMM-Todo 看板')
  expect(doc.regions.length).toBeGreaterThan(0)
})

test('分区与需求一致', () => {
  const doc = parse(read('DEMAND.md'))
  const files = [
    'web/src/components/ProjectSidebar.tsx',
    'web/src/components/TaskSection.tsx',
    'web/src/components/TaskDetailSheet.tsx',
    'web/src/components/ProjectEditorSheet.tsx',
  ]
  const ids = new Set<string>()
  for (const file of files) for (const id of regionIdsFromSource(read(file))) ids.add(id)
  expect([...check(ids, doc)]).toEqual([])
})
