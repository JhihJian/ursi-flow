import { readFileSync } from 'node:fs'
import { pluginManifest } from '../src/plugin-manifest.ts'
import { parsePortalConfig } from '../src/portal-config.ts'

const file = process.argv[2]
if (!file) {
  console.error('用法：npm run portal:check-config -- <portal-config.json>')
  process.exit(2)
}
try {
  const config = parsePortalConfig(JSON.parse(readFileSync(file, 'utf8')), pluginManifest, 'https://portal.example')
  console.log(`配置 ${config.revision} 校验通过`)
} catch (error) {
  console.error(`配置校验失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
