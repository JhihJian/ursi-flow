<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { api, errorMessage } from '@/shared/api'
import { confirmation, confirmAction, dismissToast, finishConfirmation, notify, toasts } from '@/shared/composables/feedback'
import AppButton from '@/shared/ui/AppButton.vue'
import AppModal from '@/shared/ui/AppModal.vue'
import AppSwitch from '@/shared/ui/AppSwitch.vue'
import Icon from '@/shared/ui/Icon.vue'
import ResourceState from '@/shared/ui/ResourceState.vue'
import ShellSidebar from '@/shared/ui/ShellSidebar.vue'
import { navigation } from './router'
import { theme, toggleTheme } from './theme'

const route = useRoute()
const router = useRouter()
const isDemo = import.meta.env.VITE_API_MODE !== 'live'
const drawerOpen = ref(false)
const failedTarget = ref<string | null>(null)
const removeErrorHandler = router.onError((_error, to) => { failedTarget.value = to.fullPath })
const removeAfterHook = router.afterEach((_to, _from, failure) => {
  if (!failure) { failedTarget.value = null; drawerOpen.value = false }
})
onUnmounted(() => { removeErrorHandler(); removeAfterHook() })
watch(() => route.fullPath, () => { drawerOpen.value = false })
function retryNavigation() {
  if (failedTarget.value) window.location.assign(router.resolve(failedTarget.value).href)
}
const icons: Record<string, string> = { '/workflows': 'workflow', '/roles': 'users', '/runs': 'runs', '/artifacts': 'artifact', '/sandboxes': 'server', '/connections': 'connector' }
const groups = computed(() => [
  { title: '编排与协作', paths: ['/workflows', '/roles', '/runs'] },
  { title: '资源与环境', paths: ['/artifacts', '/sandboxes', '/connections'] },
].map((group) => ({ title: group.title, items: navigation.filter((item) => group.paths.includes(item.path)).map((item) => ({ ...item, icon: icons[item.path] ?? 'folder' })) })))
const currentDomain = computed(() => navigation.find((item) => route.path === item.path || route.path.startsWith(`${item.path}/`)))

interface DemoSettings { delay: number; failNext: boolean }
const settingsOpen = ref(false)
const settingsLoading = ref(false)
const settingsSaving = ref(false)
const settingsError = ref('')
const settingsReady = ref(false)
const settings = reactive<DemoSettings>({ delay: 0, failNext: false })
async function loadSettings() {
  settingsLoading.value = true
  settingsReady.value = false
  settingsError.value = ''
  try { Object.assign(settings, await api.get<DemoSettings>('/demo/settings')); settingsReady.value = true }
  catch (error) { settingsError.value = errorMessage(error) }
  finally { settingsLoading.value = false }
}
function openSettings() {
  drawerOpen.value = false
  settingsOpen.value = true
  void loadSettings()
}
async function saveSettings() {
  if (!Number.isFinite(settings.delay) || settings.delay < 0 || settings.delay > 30000) {
    settingsError.value = '请求延迟需在 0 到 30000 毫秒之间。'
    return
  }
  settingsSaving.value = true
  settingsError.value = ''
  try {
    await api.put<DemoSettings>('/demo/settings', { delay: Math.round(settings.delay), failNext: settings.failNext })
    settingsOpen.value = false
    notify('演示设置已保存')
  } catch (error) { settingsError.value = errorMessage(error) }
  finally { settingsSaving.value = false }
}
async function resetDemo() {
  if (!await confirmAction({ title: '重置演示数据？', description: '将清除本地修改与运行记录，恢复初始演示数据，并重新加载页面。', danger: true, confirmLabel: '重置演示' })) return
  settingsSaving.value = true
  try { await api.post('/demo/reset'); window.location.reload() }
  catch (error) { settingsError.value = errorMessage(error) }
  finally { settingsSaving.value = false }
}
</script>

<template>
  <a href="#main-content" class="skip-link">跳到主要内容</a>
  <div class="app-shell">
    <aside class="desktop-sidebar">
      <ShellSidebar :groups="groups" :dark="theme === 'dark'" :demo="isDemo" @theme="toggleTheme" @settings="openSettings" />
    </aside>
    <div class="min-w-0">
      <header class="shell-topbar">
        <button type="button" class="icon-button lg:hidden" aria-label="打开导航菜单" :aria-expanded="drawerOpen" aria-haspopup="dialog" @click="drawerOpen = true"><Icon name="menu" :size="21" /></button>
        <nav aria-label="面包屑" class="flex min-w-0 items-center gap-2 text-sm">
          <span class="hidden shrink-0 text-txt3 sm:inline">工作台</span><Icon name="chevron-right" :size="13" class="hidden text-txt3 sm:inline" />
          <RouterLink v-if="currentDomain && route.path !== currentDomain.path" :to="currentDomain.path" class="shrink-0 text-txt3 hover:text-txt">{{ currentDomain.title }}</RouterLink>
          <Icon v-if="currentDomain && route.path !== currentDomain.path" name="chevron-right" :size="13" class="text-txt3" />
          <span aria-current="page" class="truncate font-medium text-txt">{{ route.meta.title || '工作台' }}</span>
        </nav>
        <span class="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-txt3"><span class="h-1.5 w-1.5 rounded-full" :class="isDemo ? 'bg-accent' : 'bg-info'" aria-hidden="true" />{{ isDemo ? '演示工作区' : '真实服务' }}</span>
      </header>
      <main id="main-content" tabindex="-1" class="shell-content">
        <div v-if="failedTarget" role="alert" class="mb-6 rounded-xl border border-warn/30 bg-warn/10 p-5 text-sm text-txt">
          <p>页面加载失败，请检查网络后重试。</p>
          <AppButton class="mt-3" icon="refresh" @click="retryNavigation">重新打开页面</AppButton>
        </div>
        <RouterView />
      </main>
    </div>
  </div>

  <AppModal :open="drawerOpen" title="工作区导航" placement="left" :width="280" body-overflow="hidden" @close="drawerOpen = false">
    <div class="-m-5 h-full"><ShellSidebar :groups="groups" :dark="theme === 'dark'" :demo="isDemo" @navigate="drawerOpen = false" @theme="toggleTheme" @settings="openSettings" /></div>
  </AppModal>

  <AppModal :open="settingsOpen && isDemo" title="演示模式设置" :width="480" @close="settingsOpen = false">
    <ResourceState :loading="settingsLoading" :error="!settingsReady && settingsError" @retry="loadSettings" />
    <form v-if="settingsReady && !settingsLoading" id="demo-settings" class="space-y-6" @submit.prevent="saveSettings">
      <p class="text-sm leading-6 text-txt3">调整请求速度与失败场景，体验应用的加载、重试和恢复流程。数据仅保存在当前浏览器。</p>
      <label class="field"><span class="field-label">请求延迟 <span class="font-normal text-txt3">（毫秒）</span></span><input v-model.number="settings.delay" class="input" type="number" min="0" max="30000" step="100" :disabled="settingsSaving" /><span class="text-xs text-txt3">设为 0 可立即响应，最大 30000 毫秒。</span></label>
      <div class="flex items-center justify-between gap-4 rounded-lg border border-line p-4"><div><label id="fail-next-label" class="text-sm font-medium text-txt">让下一次请求失败</label><p class="mt-1 text-xs text-txt3">保存后，下一个业务请求将返回模拟错误。</p></div><AppSwitch v-model="settings.failNext" aria-labelledby="fail-next-label" :disabled="settingsSaving" /></div>
      <p v-if="settingsError" role="alert" class="text-sm text-err">{{ settingsError }}</p>
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5"><div><p class="text-sm font-medium text-txt">恢复初始数据</p><p class="mt-1 text-xs text-txt3">清除当前浏览器中的演示修改。</p></div><AppButton variant="danger" icon="refresh" :disabled="settingsSaving" @click="resetDemo">重置演示</AppButton></div>
    </form>
    <template #footer><AppButton @click="settingsOpen = false">取消</AppButton><AppButton type="submit" form="demo-settings" variant="primary" :loading="settingsSaving" :disabled="settingsLoading || !settingsReady">保存设置</AppButton></template>
  </AppModal>

  <AppModal :open="!!confirmation" :title="confirmation?.title" :width="440" @close="finishConfirmation(false)">
    <p class="text-sm leading-7 text-txt2">{{ confirmation?.description }}</p>
    <template #footer><AppButton autofocus @click="finishConfirmation(false)">取消</AppButton><AppButton :variant="confirmation?.danger ? 'danger' : 'primary'" @click="finishConfirmation(true)">{{ confirmation?.confirmLabel || '确认' }}</AppButton></template>
  </AppModal>

  <div class="toast-region" aria-live="polite" aria-relevant="additions" aria-label="操作通知">
    <div v-for="toast in toasts" :key="toast.id" class="toast-item" :class="toast.kind === 'error' ? 'border-err/30' : 'border-line'">
      <Icon :name="toast.kind === 'error' ? 'warning' : 'check'" :class="toast.kind === 'error' ? 'text-err' : 'text-ok'" />
      <p class="min-w-0 flex-1 break-words text-sm text-txt">{{ toast.message }}</p>
      <button type="button" class="icon-button h-7 w-7" aria-label="关闭通知" @click="dismissToast(toast.id)"><Icon name="close" :size="15" /></button>
    </div>
  </div>
</template>
