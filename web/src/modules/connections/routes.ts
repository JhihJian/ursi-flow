import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  {
    path: '/connections',
    name: 'connections',
    component: () => import('./ConnectionsView.vue'),
    meta: { title: '模型连接', description: '配置模型服务端点、凭据引用与能力选择。' },
  },
]
