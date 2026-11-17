import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  {
    path: '/runs',
    name: 'runs',
    component: () => import('./RunsView.vue'),
    meta: { title: '运行记录', description: '追踪运行进度、查看执行事件并处理人工审批。', nav: true },
  },
  {
    path: '/runs/:id',
    name: 'run-detail',
    component: () => import('./RunDetailView.vue'),
    meta: { title: '运行详情', description: '查看节点执行、事件、产物与冻结配置。' },
  },
]
