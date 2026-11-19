/** 开发代理：v1 是 Flow 工具，v2 是工作管理，两版 API 同源同端口转发到同一个服务。 */
export function apiProxy(target: string): Record<string, { target: string }> {
  return { '/api/v1': { target }, '/api/v2': { target } }
}
