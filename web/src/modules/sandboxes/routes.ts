import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  {
    path: '/sandboxes',
    name: 'sandboxes',
    component: () => import('./SandboxesView.vue'),
    meta: { title: '沙箱管理', description: '查看执行资源、运行关联与获准的访问入口。' },
  },
]
