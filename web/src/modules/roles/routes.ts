import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  {
    path: '/roles',
    name: 'roles',
    component: () => import('./RolesView.vue'),
    meta: { title: '角色管理', description: '管理角色提示词、技能文件、MCP 与模型选择。' },
  },
]
