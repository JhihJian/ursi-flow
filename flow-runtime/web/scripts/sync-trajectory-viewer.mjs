// 把 pi-agent-trajectory-viewer 的组件与纯逻辑源码同步到 src/trajectory。
// 轨迹界面由上游项目维护，本目录不手改；需要修改时先改上游，再运行本脚本。
// 参考样式带上游的 body 作用域，复制时统一收进 .trajectory-host，避免污染控制台全局样式。
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const web = resolve(here, '..')
const source = resolve(
  process.env.TRAJECTORY_VIEWER ?? '/data/dev/pi-agent-trajectory-viewer',
)
const target = join(web, 'src', 'trajectory')

// 只同步组件层与无 React 依赖的逻辑层，展示站与样例数据不进控制台。
const trees = [
  ['src/components', 'components'],
  ['src/lib', 'lib'],
]
// 参考样式文件里的全局选择器逐条改写成轨迹容器作用域。
const scoped = [
  'base.css',
  'design-platform.css',
  'focus.css',
  'gradient-shadow-text.css',
  'scrollbar.css',
  'shiki.css',
]

function scope(text, file) {
  const before = text
  text = text.replace(
    /^(\s*)body\[data-ds-dark-theme\]/gm,
    '$1.trajectory-host[data-ds-dark-theme]',
  )
  text = text.replace(/^(\s*)body \* \{/gm, '$1.trajectory-host * {')
  text = text.replace(/^(\s*)body,\s*$/gm, '$1.trajectory-host,')
  text = text.replace(/^(\s*)body \{/gm, '$1.trajectory-host {')
  text = text.replace(/^(\s*):root \{/gm, '$1.trajectory-host {')
  text = text.replace(
    /^(\s*):focus-visible \{/gm,
    '$1.trajectory-host :focus-visible {',
  )
  text = text.replace(
    /^(\s*)::-webkit-scrollbar/gm,
    '$1.trajectory-host ::-webkit-scrollbar',
  )
  text = text.replace(
    /^html\[data-platform='darwin'\] body/gm,
    '.trajectory-host',
  )
  text = text.replace(
    /^html\[data-input-modality='pointer'\] body /gm,
    '.trajectory-host ',
  )
  const leaked = text
    .split('\n')
    .filter((line) =>
      /^(body|:root|:focus-visible|::-webkit-scrollbar)/.test(line.trim()),
    )
  if (leaked.length)
    throw new Error(`${file} 仍有未收进作用域的全局选择器：${leaked.join(' / ')}`)
  if (text === before) throw new Error(`${file} 没有可改写的全局选择器`)
  return text
}

async function main() {
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  // 只重铺上游源码，保留本目录的宿主样式、主题桥接与来源说明。
  await mkdir(target, { recursive: true })
  for (const [from, to] of trees) {
    await rm(join(target, to), { recursive: true, force: true })
    await cp(join(source, from), join(target, to), { recursive: true })
  }

  const reference = join(target, 'components', 'reference')
  for (const file of scoped) {
    const path = join(reference, file)
    await writeFile(path, scope(await readFile(path, 'utf8'), file))
  }

  // 上游聚合入口保持原样，只在其后追加控制台主题桥接。
  const aggregate = join(target, 'components', 'styles', 'index.css')
  const css = await readFile(aggregate, 'utf8')
  await writeFile(
    aggregate,
    css.trimEnd() + "\n@import '../../theme-bridge.css';\n",
  )

  await cp(join(source, 'LICENSE'), join(target, 'LICENSE'))
  await cp(join(source, 'THIRD_PARTY_NOTICES.md'), join(target, 'THIRD_PARTY_NOTICES.md'))
  await writeFile(
    join(target, 'VENDOR.json'),
    JSON.stringify(
      {
        source,
        commit,
        synced: new Date().toISOString(),
        trees: trees.map(([from]) => from),
        scoped,
      },
      null,
      2,
    ) + '\n',
  )
  process.stdout.write(
    `已同步 ${source}@${commit.slice(0, 8)} → src/trajectory\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
