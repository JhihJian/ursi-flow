import { describe, expect, it } from 'vitest'

import {
  basename, decodeBlob, formatBytes, isBinaryPath, isMarkdownPath, isSameOrInside, joinPath, languageOf,
  normalizePath, parentPath,
} from './paths'
import { uploadRelativePath } from './use-explorer'

describe('包内相对路径', () => {
  it('拼接时丢掉空段和当前目录，保留上级引用', () => {
    expect(joinPath('', 'a', '/b.md')).toBe('a/b.md')
    expect(joinPath('docs/', './guide.md')).toBe('docs/guide.md')
    expect(joinPath('docs', '', '../x.md')).toBe('docs/../x.md')
    expect(normalizePath('/skills//tool/')).toBe('skills/tool')
    expect(joinPath()).toBe('')
  })

  it('定位父目录、文件名与包含关系', () => {
    expect(parentPath('docs/guide.md')).toBe('docs')
    expect(parentPath('AGENTS.md')).toBe('')
    expect(basename('docs/guide.md')).toBe('guide.md')
    expect(isSameOrInside('docs/a.md', 'docs')).toBe(true)
    expect(isSameOrInside('docs', 'docs')).toBe(true)
    expect(isSameOrInside('docs2/a.md', 'docs')).toBe(false)
  })

  it('按扩展名给出语言与 Markdown 判定', () => {
    expect(languageOf('a.md')).toBe('Markdown')
    expect(languageOf('b.json')).toBe('JSON')
    expect(languageOf('Makefile')).toBe('Text')
    expect(isMarkdownPath('README.MD')).toBe(true)
    expect(isMarkdownPath('notes.txt')).toBe(false)
  })
})

describe('二进制判定', () => {
  it('压缩包、图片等扩展名直接按二进制处理', () => {
    expect(isBinaryPath('logo.PNG')).toBe(true)
    expect(isBinaryPath('bundle.zip')).toBe(true)
    expect(isBinaryPath('AGENTS.md')).toBe(false)
  })

  it('文本按 UTF-8 解码，空字节与非法编码都当作二进制', async () => {
    const source = new Blob(['# 标题\n正文'])
    const text = await decodeBlob(source, 'a.md')
    expect(text).toEqual({ binary: false, text: '# 标题\n正文', size: source.size })

    const nul = await decodeBlob(new Blob([Uint8Array.of(65, 0, 66)]), 'raw.dat.bin')
    expect(nul.binary).toBe(true)

    const invalid = await decodeBlob(new Blob([Uint8Array.of(0xc3, 0x28)]), 'broken.txt')
    expect(invalid.binary).toBe(true)

    const extension = await decodeBlob(new Blob(['plain text']), 'photo.png')
    expect(extension.binary).toBe(true)
  })

  it('超过 2MB 的文件不读成文本，避免整份载入编辑器', async () => {
    const blob = new Blob(['x'.repeat(2 * 1024 * 1024 + 1)])
    expect((await decodeBlob(blob, 'big.txt')).binary).toBe(true)
  })

  it('显示文件大小', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('目录导入保留路径', () => {
  it('去掉选择的顶层目录名，保留其下的相对路径', () => {
    const nested = new File(['x'], 'b.md')
    Object.defineProperty(nested, 'webkitRelativePath', { value: 'pkg/skills/b.md' })
    expect(uploadRelativePath(nested)).toBe('skills/b.md')

    const flat = new File(['x'], 'a.md')
    expect(uploadRelativePath(flat)).toBe('a.md')
  })
})
