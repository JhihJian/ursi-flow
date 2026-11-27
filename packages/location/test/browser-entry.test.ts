import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

test('主出口不依赖 Node，浏览器可直接引用', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /node:/, 'src/index.ts 里不得出现 node: 模块')
  assert.doesNotMatch(source, /from '\.\/keys/, 'src/index.ts 不得再导出 keys.ts')
})

test('契约保持纯函数，不变成客户端 SDK', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  // 基座是一组契约，不是一个服务：不发请求、不 import 兄弟模块、不持有状态。
  // 一旦开始 fetch，它就得知道 ssh-web 在哪、要缓存设备清单，纯函数包就变成有状态的客户端。
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'src/index.ts 不得发请求')
  assert.doesNotMatch(source, /from '@ursi\//, 'src/index.ts 不得依赖其它 @ursi 包')
  assert.doesNotMatch(source, /^\s*(let|const)\s+\w+\s*=\s*new\s+(Map|Set|WeakMap)\b/m, 'src/index.ts 不得持有模块级缓存')
})
