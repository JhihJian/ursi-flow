import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  {
    path: '/artifacts',
    name: 'artifacts',
    component: () => import('./ArtifactsView.vue'),
    meta: { title: '产物管理', description: '查阅运行交付物，追溯节点与执行轮次。' },
  },
]
