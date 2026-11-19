import { describe, expect, it } from 'vitest'

import { apiProxy } from './dev-proxy'

/** 深链登录和页面路由仍由 Vite 自己处理，代理只接管两版业务 API。 */
describe('开发代理', () => {
  it('v1 与 v2 都转发到同一个服务地址', () => {
    const proxy = apiProxy('http://127.0.0.1:8080')
    expect(Object.keys(proxy).sort()).toEqual(['/api/v1', '/api/v2'])
    expect(proxy['/api/v1']?.target).toBe('http://127.0.0.1:8080')
    expect(proxy['/api/v2']?.target).toBe('http://127.0.0.1:8080')
  })
})
