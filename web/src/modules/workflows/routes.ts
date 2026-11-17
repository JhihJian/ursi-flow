import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  {
    path: '/workflows',
    name: 'workflows',
    component: () => import('./WorkflowsView.vue'),
    meta: { title: '工作流', description: '编排流程定义，查看节点依赖并发起运行。', nav: true },
  },
]
