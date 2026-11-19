async function json(path, signal) {
  const r = await fetch(path, { signal, cache: 'no-store' })
  if (!r.ok)
    throw new Error(
      {
        401: '身份验证失败',
        403: '无权访问',
        404: '资源不存在',
        502: 'Gateway 连接失败',
        503: 'Gateway 暂不可用',
      }[r.status] || `请求失败（HTTP ${r.status}）`,
    )
  return r.json()
}
export async function loadSource(signal) {
  const { mode } = await json('/console-config.json', signal)
  if (mode === 'demo') {
    const { rows } = await import('./demo.js')
    const item = (id) => {
      const row = rows.find((r) => r.id === id)
      if (!row) throw new Error('沙箱不存在')
      return row
    }
    return {
      demo: true,
      list: () => rows,
      detail: item,
      logs: (id) =>
        `[demo] ${item(id).spec.labels.name}\n[status] ${item(id).error || item(id).status}`,
    }
  }
  if (mode !== 'gateway') throw new Error('数据源配置无效')
  const base = '/api/v1/sandboxes'
  return {
    demo: false,
    list: async (s) => (await json(base, s)).sandboxes,
    detail: (id, s) => json(`${base}/${encodeURIComponent(id)}`, s),
    logs: async (id, s) =>
      (await json(`${base}/${encodeURIComponent(id)}/logs?tail=200`, s))
        .content,
  }
}
