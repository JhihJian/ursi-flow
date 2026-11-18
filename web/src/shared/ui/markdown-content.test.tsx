// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { MarkdownContent } from './markdown-content'

describe('产物 Markdown 预览', () => {
  it('保留标题（预览内降一级）、表格与清单', () => {
    const { container } = render(<MarkdownContent content={'# 交付报告\n\n- 已验证\n\n| 项目 | 结果 |\n| --- | --- |\n| 测试 | 通过 |'} />)
    expect(container.querySelector('h1')).toBeNull()
    expect(container.querySelector('h2')?.textContent).toBe('交付报告')
    expect(container.querySelector('li')?.textContent).toBe('已验证')
    expect(container.querySelector('table')?.textContent).toContain('通过')
  })

  it('移除脚本、事件属性、危险链接和远程图片', () => {
    const { container } = render(
      <MarkdownContent
        content={'<script>alert(1)</script><p onclick="alert(1)">安全文字</p><a href="javascript:alert(1)">链接</a><img src="https://tracking.example.com/pixel"><iframe src="https://example.com"></iframe><svg><image href="https://tracking.example.com/pixel" width="1" height="1"/></svg><video src="https://tracking.example.com/video" autoplay></video>'}
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('image')).toBeNull()
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('p')?.getAttribute('onclick')).toBeNull()
    expect(container.querySelector('a')?.getAttribute('href')).toBeNull()
    expect(container.textContent).toContain('安全文字')
  })

  it('容器使用全局 markdown-content 类', () => {
    const { container } = render(<MarkdownContent content="正文" />)
    expect(container.firstElementChild).toHaveClass('markdown-content')
    expect(screen.getByText('正文').tagName).toBe('P')
  })

  it('净化面不放宽 class：内容自带的类名被清除，只有降级后的一级标题带 markdown-title', () => {
    const { container } = render(
      <MarkdownContent content={'<h1 class="page-title">文档标题</h1>\n\n<p class="injected">正文</p>\n\n## 二级标题\n\n### 三级标题\n\n##### 五级标题'} />,
    )

    const titles = container.querySelectorAll('.markdown-title')
    expect(titles).toHaveLength(1)
    expect(titles[0]?.tagName).toBe('H2')
    expect(titles[0]?.textContent).toBe('文档标题')
    expect(container.querySelector('.page-title')).toBeNull()
    expect(container.querySelector('.injected')).toBeNull()
    // 其他级别的标题同样降一级，六级标题保持不变。
    expect(Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((node) => `${node.tagName}:${node.textContent}`)).toEqual([
      'H2:文档标题', 'H3:二级标题', 'H4:三级标题', 'H6:五级标题',
    ])
  })

  it('标题降级在净化之后完成，不引入新的不信任属性', () => {
    const { container } = render(<MarkdownContent content={'<h1 onclick="alert(1)" id="x" style="color:red">标题</h1>'} />)
    const heading = container.querySelector('h2')
    expect(heading?.getAttribute('onclick')).toBeNull()
    expect(heading?.getAttribute('id')).toBeNull()
    expect(heading?.getAttribute('style')).toBeNull()
    expect(heading?.className).toBe('markdown-title')
  })
})
