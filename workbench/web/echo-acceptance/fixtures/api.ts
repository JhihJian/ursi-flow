/** 辅助校验用的 HTTP 客户端。主路径由浏览器完成；这里只读取服务端事实。 */
import type { Runtime } from './runtime'

export interface Role { id: string; label: string }
export interface Material { role: string; name: string; size: number }
export interface Attempt { id: string; status: 'succeeded' | 'failed'; error?: string }
export interface Sop { id: string; revision: number; executor: string; config: { title: string } }
export interface WorkspaceType {
  id: string
  name: string
  roles: Role[]
  sop: { id: string; revision: number }
}
export interface WorkspaceDetail {
  id: string
  typeId: string
  requirement: string
  frozen: boolean
  roles: Role[]
  sop: Sop
  materials: Material[]
  attempts: Attempt[]
}

export interface ReceiptResult {
  body: string
  contentType: string
  disposition: string | null
}

export class WorkApi {
  constructor(private readonly runtime: Runtime) {}

  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.runtime.apiBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.runtime.token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    return response
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init)
    if (!response.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} 返回 HTTP ${response.status}：${await response.text()}`)
    }
    return response.json() as Promise<T>
  }

  types() {
    return this.json<WorkspaceType[]>('/api/v2/workspace-types')
  }

  create(body: { typeId: string; requirement: string; sop?: { id: string; revision: number } }) {
    return this.json<WorkspaceDetail>('/api/v2/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  list() {
    return this.json<WorkspaceDetail[]>('/api/v2/workspaces')
  }

  get(id: string) {
    return this.json<WorkspaceDetail>(`/api/v2/workspaces/${encodeURIComponent(id)}`)
  }

  patch(id: string, requirement: string) {
    return this.request(`/api/v2/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirement }),
    })
  }

  /** 上传原始字节。冻结后服务端返回 409，测试用它核对拒绝边界。 */
  attemptUpload(id: string, role: string, name: string, content: string) {
    const query = new URLSearchParams({ name })
    return this.request(
      `/api/v2/workspaces/${encodeURIComponent(id)}/materials/${encodeURIComponent(role)}?${query}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(Buffer.from(content, 'utf8')),
      },
    )
  }

  async upload(id: string, role: string, name: string, content: string) {
    const response = await this.attemptUpload(id, role, name, content)
    if (!response.ok) throw new Error(`上传材料返回 HTTP ${response.status}：${await response.text()}`)
    return response.json() as Promise<WorkspaceDetail>
  }

  run(id: string) {
    return this.json<WorkspaceDetail>(`/api/v2/workspaces/${encodeURIComponent(id)}/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  }

  async receipt(id: string, attempt: string, download = false): Promise<ReceiptResult> {
    const suffix = download ? '?download=true' : ''
    const response = await this.request(
      `/api/v2/workspaces/${encodeURIComponent(id)}/attempts/${encodeURIComponent(attempt)}/receipt${suffix}`,
    )
    if (!response.ok) throw new Error(`读取回执返回 HTTP ${response.status}：${await response.text()}`)
    return {
      body: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
      disposition: response.headers.get('content-disposition'),
    }
  }
}
