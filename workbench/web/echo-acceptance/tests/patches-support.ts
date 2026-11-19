import { expect, type Page, type TestInfo } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { evidenceDir } from '../fixtures/paths'
import { readRuntime, type Runtime } from '../fixtures/runtime'

export type PatchKind = 'work' | 'config'
export interface PatchEntry { path: string; kind: 'file' | 'dir'; size?: number }
export interface PatchRef { id: string; name: string; directoryId: string }

/**
 * 虚拟目录的服务端事实：只读树与原文，供浏览器断言之外的落盘核对。
 * 主路径仍由浏览器完成，这里不替页面写入。
 */
export class PatchApi {
  readonly token: string
  private readonly runtime: Runtime

  constructor(runtime: Runtime = readRuntime()) {
    this.runtime = runtime
    this.token = runtime.token
  }

  private async request(url: string, init: RequestInit = {}) {
    return fetch(`${this.runtime.apiBase}${url}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.runtime.token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  }

  async list(kind: PatchKind): Promise<PatchRef[]> {
    const response = await this.request(`/api/v2/patches/${kind}`)
    if (!response.ok) throw new Error(`读取${kind}包列表返回 HTTP ${response.status}：${await response.text()}`)
    return response.json() as Promise<PatchRef[]>
  }

  /** 包记录只用来拿到目录标识，内容读写一律走虚拟目录接口。 */
  async patch(kind: PatchKind, id: string): Promise<PatchRef> {
    const found = (await this.list(kind)).find(item => item.id === id)
    if (!found) throw new Error(`${kind}包 ${id} 不在列表中`)
    return found
  }

  async tree(directoryId: string): Promise<PatchEntry[]> {
    const response = await this.request(`/api/v2/directories/${encodeURIComponent(directoryId)}/tree`)
    if (!response.ok) throw new Error(`读取目录树返回 HTTP ${response.status}：${await response.text()}`)
    return response.json() as Promise<PatchEntry[]>
  }

  async read(directoryId: string, file: string): Promise<Buffer> {
    const query = new URLSearchParams({ path: file })
    const response = await this.request(`/api/v2/directories/${encodeURIComponent(directoryId)}/file?${query}`)
    if (!response.ok) throw new Error(`读取 ${file} 返回 HTTP ${response.status}：${await response.text()}`)
    return Buffer.from(await response.arrayBuffer())
  }

  async text(directoryId: string, file: string): Promise<string> {
    return (await this.read(directoryId, file)).toString('utf8')
  }
}

/** 截取主要交互面，按项目分目录留存；令牌与私有材料不进入截图以外的证据。 */
export async function shot(page: Page, testInfo: TestInfo, name: string) {
  const dir = path.join(evidenceDir, 'patches', testInfo.project.name)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${name}.png`) })
}

/** 从地址里取出当前包标识。 */
export function patchIdFromUrl(url: string, kind: PatchKind): string {
  const prefix = kind === 'work' ? '/work-patches/' : '/config-patches/'
  const pathname = new URL(url).pathname
  if (!pathname.startsWith(prefix)) throw new Error(`地址不是${kind}包编辑台：${url}`)
  return decodeURIComponent(pathname.slice(prefix.length))
}

/** 等页面发起的目录写入在服务端可见，避免用界面缓存判定成功。 */
export async function expectEntry(api: PatchApi, directoryId: string, entry: PatchEntry) {
  await expect.poll(async () => (await api.tree(directoryId)).some(item => item.path === entry.path && item.kind === entry.kind), {
    timeout: 15_000,
  }).toBe(true)
}

/** 等浏览器保存后的原文在服务端可读。 */
export async function expectText(api: PatchApi, directoryId: string, file: string, expected: string) {
  await expect.poll(async () => api.text(directoryId, file), { timeout: 15_000 }).toBe(expected)
}
