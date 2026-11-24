import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders headings, paragraphs and emphasis', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>')
    expect(renderMarkdown('### Sub')).toBe('<h3>Sub</h3>')
    expect(renderMarkdown('some **bold** and *italic* and ~~gone~~')).toBe(
      '<p>some <strong>bold</strong> and <em>italic</em> and <del>gone</del></p>',
    )
  })

  it('renders fenced code without inline formatting inside', () => {
    expect(renderMarkdown('```\nconst a = 1 < 2\n```')).toBe(
      '<pre><code>const a = 1 &lt; 2</code></pre>',
    )
    expect(renderMarkdown('use `a_b` here')).toBe('<p>use <code>a_b</code> here</p>')
  })

  it('renders lists, quotes and rules', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>')
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>')
    expect(renderMarkdown('> quoted **text**')).toBe(
      '<blockquote><p>quoted <strong>text</strong></p></blockquote>',
    )
    expect(renderMarkdown('---')).toBe('<hr />')
  })

  it('keeps raw html as text and only links http(s)', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
    expect(renderMarkdown('[site](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noreferrer">site</a></p>',
    )
    expect(renderMarkdown('[bad](javascript:alert(1))')).toBe(
      '<p>[bad](javascript:alert(1))</p>',
    )
  })

  it('joins wrapped paragraph lines and skips blank lines', () => {
    expect(renderMarkdown('first line\nsecond line')).toBe('<p>first line second line</p>')
    expect(renderMarkdown('\n\n')).toBe('')
  })
})
