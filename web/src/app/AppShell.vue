<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { navigation } from './router'

const route = useRoute()
const router = useRouter()
const failedTarget = ref<string | null>(null)
const removeErrorHandler = router.onError((_error, to) => { failedTarget.value = to.fullPath })
const removeAfterHook = router.afterEach((_to, _from, failure) => {
  if (!failure) failedTarget.value = null
})
onUnmounted(() => { removeErrorHandler(); removeAfterHook() })
function retryNavigation() {
  if (failedTarget.value) window.location.assign(router.resolve(failedTarget.value).href)
}
</script>

<template>
  <a href="#main-content" class="skip-link">跳到主要内容</a>
  <div class="min-h-screen lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
    <aside class="border-b border-white/10 bg-ink text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-b-0">
      <RouterLink to="/workflows" class="flex items-center gap-3 px-6 py-6" aria-label="ursi-flow 首页">
        <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-400/15 text-teal-300" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M6 6v8a4 4 0 0 0 4 4h8M6 6h12M18 6v12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            <circle cx="6" cy="6" r="3" fill="currentColor" /><circle cx="18" cy="18" r="3" fill="currentColor" />
          </svg>
        </span>
        <span><span class="block text-lg font-semibold tracking-tight">ursi-flow</span><span class="block text-xs text-slate-300">流程与 Agent 协作</span></span>
      </RouterLink>
      <nav aria-label="主导航" class="grid grid-cols-3 gap-1 px-3 pb-4 sm:grid-cols-6 lg:flex lg:flex-col lg:gap-2 lg:px-4 lg:pt-6">
        <RouterLink
          v-for="(item, index) in navigation" :key="item.path" :to="item.path"
          class="flex items-center gap-3 rounded-lg px-3 py-3 text-sm text-slate-300 transition-colors hover:bg-white/5 hover:text-white"
          active-class="nav-active"
        >
          <span class="hidden text-[10px] tabular-nums text-slate-400 lg:inline" aria-hidden="true">0{{ index + 1 }}</span>
          <span>{{ item.title }}</span>
        </RouterLink>
      </nav>
      <div class="mt-auto hidden border-t border-white/10 px-6 py-6 text-xs leading-6 text-slate-300 lg:block">
        定义流程，配置角色。<br />让每一次交付有迹可循。
      </div>
    </aside>
    <div class="min-w-0">
      <header class="flex h-16 items-center justify-between gap-4 border-b border-line bg-white px-5 sm:px-9">
        <p class="text-sm text-muted">工作台 <span class="mx-2 text-slate-300" aria-hidden="true">/</span> <span class="text-ink">{{ route.meta.title }}</span></p>
        <span class="rounded-full border border-line px-3 py-1 text-xs text-muted">初始版本</span>
      </header>
      <main id="main-content" tabindex="-1" class="mx-auto max-w-6xl px-5 py-8 sm:px-9 sm:py-12">
        <div v-if="failedTarget" role="alert" class="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950">
          <p>页面加载失败，请检查网络后重试。</p>
          <button type="button" class="mt-3 rounded-md border border-amber-400 px-3 py-2 font-medium" @click="retryNavigation">重新打开页面</button>
        </div>
        <RouterView />
      </main>
    </div>
  </div>
</template>
