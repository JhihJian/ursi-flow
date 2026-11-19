// 与 Gateway 相同的展示字段。演示模式不发起 Gateway 请求。
const samples = [
  ['release-review', 'running', 'ursi-runtime-pi:local', 2, 2048],
  ['hello-html', 'running', 'nginx:alpine', 1, 256],
  ['daily-close', 'stopped', 'python:3.12-slim', 1, 512],
  ['workspace-check', 'preparing', 'ursi-runtime-pi:local', 2, 1024],
  ['asset-preview', 'running', 'node:22-alpine', 1, 512],
  ['bundle-verify', 'error', 'ursi-runtime-pi:local', 2, 1024],
]
export const rows = samples.map(
  ([name, status, image, cpus, memory_mb], i) => ({
    id: `b7d2a94${i}a2314786a2182ac21f53ae2${i}`,
    status,
    revision: i + 2,
    spec: { image, labels: { name }, cpus, memory_mb, runtime_profile: null },
    operation: status === 'preparing' ? { kind: 'create' } : null,
    resource: { generation: 1, data_generation: 1 },
    error: status === 'error' ? '运行包校验失败' : null,
    endpoints:
      status === 'running'
        ? [
            {
              name: 'web',
              port: 8080,
              visibility: 'public',
              address: `127.0.0.1:${32100 + i}`,
            },
          ]
        : [],
  }),
)
