import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

test('主出口不依赖 Node，浏览器可直接引用', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /node:/, 'src/index.ts 里不得出现 node: 模块')
  assert.doesNotMatch(source, /from '\.\/keys/, 'src/index.ts 不得再导出 keys.ts')
})
