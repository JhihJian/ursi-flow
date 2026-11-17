// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownContent from './MarkdownContent.vue'

describe('产物 Markdown 预览', () => {
  it('保留标题、表格与清单', () => {
    const view = mount(MarkdownContent, { props: { content: '# 交付报告\n\n- 已验证\n\n| 项目 | 结果 |\n| --- | --- |\n| 测试 | 通过 |' } })
    expect(view.get('h1').text()).toBe('交付报告')
    expect(view.get('li').text()).toBe('已验证')
    expect(view.get('table').text()).toContain('通过')
  })
  it('移除脚本、事件属性、危险链接和远程图片', () => {
    const view = mount(MarkdownContent, { props: { content: '<script>alert(1)</script><p onclick="alert(1)">安全文字</p><a href="javascript:alert(1)">链接</a><img src="https://tracking.example.com/pixel"><iframe src="https://example.com"></iframe><svg><image href="https://tracking.example.com/pixel" width="1" height="1"/></svg><video src="https://tracking.example.com/video" autoplay></video>' } })
    expect(view.find('script').exists()).toBe(false)
    expect(view.find('img').exists()).toBe(false)
    expect(view.find('iframe').exists()).toBe(false)
    expect(view.find('svg').exists()).toBe(false)
    expect(view.find('image').exists()).toBe(false)
    expect(view.find('video').exists()).toBe(false)
    expect(view.get('p').attributes('onclick')).toBeUndefined()
    expect(view.get('a').attributes('href')).toBeUndefined()
    expect(view.text()).toContain('安全文字')
  })
})
