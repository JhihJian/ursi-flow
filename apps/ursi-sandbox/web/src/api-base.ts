/**
 * 模块级 API 基准路径。
 *
 * 独立部署时缺省用相对路径（与 server.mjs 同源）；嵌入工作台外壳时由
 * createSandboxModule({ apiBase }) 覆盖为宿主注入的代理前缀（如 /sbx）。
 * 所有 fetch 与 沙箱工作台的 WS 地址都从这里取基准，不再散落硬编码。
 */
let apiBase = './'
export function setApiBase(value: string) {
  apiBase = value
}

/** 相对 API 基准拼成 URL（fetch 直接可用，WS 地址经 location.href 解析）。 */
export function apiUrl(path: string): string {
  return apiBase + path.replace(/^\.\//, '')
}
