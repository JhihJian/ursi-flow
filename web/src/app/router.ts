import { createRouter, createWebHistory, type RouterHistory } from 'vue-router'
import { routes as workflowRoutes } from '@/modules/workflows/routes'
import { routes as roleRoutes } from '@/modules/roles/routes'
import { routes as runRoutes } from '@/modules/runs/routes'
import { routes as artifactRoutes } from '@/modules/artifacts/routes'
import { routes as sandboxRoutes } from '@/modules/sandboxes/routes'
import { routes as connectionRoutes } from '@/modules/connections/routes'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    description?: string
    nav?: boolean
  }
}

const domainRoutes = [
  ...workflowRoutes, ...roleRoutes, ...runRoutes,
  ...artifactRoutes, ...sandboxRoutes, ...connectionRoutes,
]

export const navigation = domainRoutes.filter((route) => !route.path.includes(':') && route.meta?.nav !== false).map((route) => ({
  path: route.path,
  title: route.meta?.title ?? '',
}))

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  const router = createRouter({
    history,
    routes: [
      { path: '/', redirect: '/workflows' },
      ...domainRoutes,
      {
        path: '/:pathMatch(.*)*',
        name: 'not-found',
        component: () => import('./NotFoundView.vue'),
        meta: { title: '页面未找到' },
      },
    ],
    scrollBehavior: () => ({ top: 0 }),
  })
  router.afterEach((to, _from, failure) => {
    if (!failure) document.title = `${to.meta.title ?? '工作台'} · ursi-flow`
  })
  return router
}
