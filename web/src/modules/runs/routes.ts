import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  {
    path: '/runs',
    name: 'runs',
    component: () => import('./RunsView.vue'),
    meta: { title: '运行记录', description: '追踪运行进度、查看执行事件并处理人工审批。' },
  },
]
