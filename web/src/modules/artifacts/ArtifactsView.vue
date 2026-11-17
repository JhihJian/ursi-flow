<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { api } from '@/shared/api'
import type { Artifact, Run } from '@/shared/api/types'
import { useResource } from '@/shared/composables/useResource'
import { notify } from '@/shared/composables/feedback'
import AppButton from '@/shared/ui/AppButton.vue'
import AppTabs from '@/shared/ui/AppTabs.vue'
import Icon from '@/shared/ui/Icon.vue'
import MarkdownContent from '@/shared/ui/MarkdownContent.vue'
import PageHeader from '@/shared/ui/PageHeader.vue'
import ResourceState from '@/shared/ui/ResourceState.vue'

const route = useRoute()
const router = useRouter()
const { data, loading, error, load } = useResource((signal) => api.get<Artifact[]>('/artifacts', signal), [])
const runs = useResource((signal) => api.get<Run[]>('/runs', signal), [])
const search = ref('')
const runFilter = ref(typeof route.query.runId === 'string' ? route.query.runId : '')
const attemptFilter = ref('')
const selection = ref(typeof route.query.id === 'string' ? route.query.id : '')
const tab = ref('preview')
const filtered = computed(() => data.value.filter((item) => (!runFilter.value || item.runId === runFilter.value) && (!attemptFilter.value || String(item.attempt) === attemptFilter.value) && `${item.name} ${item.path}`.toLowerCase().includes(search.value.toLowerCase())))
const selected = computed(() => filtered.value.find((item) => item.id === selection.value) ?? filtered.value[0])
const attempts = computed(() => [...new Set(data.value.filter((item) => !runFilter.value || item.runId === runFilter.value).map((item) => item.attempt))].sort((a, b) => b - a))
watch(() => route.query.runId, (value) => { runFilter.value = typeof value === 'string' ? value : '' })
watch(runFilter, (value) => { attemptFilter.value = ''; void router.replace({ query: value ? { runId: value } : {} }) })
function nameOfRun(id: string) { return runs.data.value.find((run) => run.id === id)?.name ?? id }
function formatSize(size: number) { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB` }
function download() {
  if (!selected.value) return
  const item = selected.value
  const url = URL.createObjectURL(new Blob([item.content], { type: item.contentType }))
  const link = document.createElement('a')
  link.href = url; link.download = item.name; document.body.append(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  notify('产物已开始下载')
}
</script>

<template>
  <div class="page-stack">
    <PageHeader title="产物管理" description="把每一次执行的结果，沉淀为可追溯的交付物。" icon="artifact"><template #actions><AppButton icon="refresh" :loading="loading" @click="load">刷新</AppButton></template></PageHeader>
    <div class="toolbar">
      <label class="search-input"><Icon name="search" :size="16" /><input v-model="search" aria-label="搜索产物" placeholder="搜索文件名称或路径…" type="search" /></label>
      <div class="flex max-w-full flex-wrap gap-2"><select v-model="runFilter" aria-label="按运行筛选" class="select !w-auto max-w-[240px]"><option value="">全部运行</option><option v-for="run in runs.data.value" :key="run.id" :value="run.id">{{ run.name }}</option></select><select v-model="attemptFilter" aria-label="执行轮次" class="select !w-auto"><option value="">全部轮次</option><option v-for="attempt in attempts" :key="attempt" :value="String(attempt)">第 {{ attempt }} 次执行</option></select></div>
    </div>
    <ResourceState :loading="loading" :error="error" :empty="!filtered.length" title="没有找到产物" description="调整筛选条件，或完成一次流程运行来生成交付物。" @retry="load" />
    <div v-if="!loading && !error && selected" class="artifact-layout panel overflow-hidden">
      <aside class="artifact-directory border-b border-line lg:border-b-0 lg:border-r">
        <div class="flex items-center justify-between px-5 py-4 text-xs text-txt3"><span>交付文件</span><span>{{ filtered.length }} 个文件</span></div>
        <button v-for="item in filtered" :key="item.id" type="button" class="artifact-file" :class="selected.id === item.id ? 'bg-accent-dim' : 'hover:bg-elevated'" :aria-pressed="selected.id === item.id" @click="selection = item.id">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-accent-2"><Icon name="file" :size="18" /></span>
          <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium text-txt">{{ item.name }}</span><span class="mt-1 block truncate text-xs text-txt3">第 {{ item.attempt }} 次执行 · {{ formatSize(item.size) }}</span></span>
        </button>
      </aside>
      <section class="min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4"><div class="min-w-0"><h2 class="truncate font-semibold">{{ selected.name }}</h2><p class="mt-1 break-all text-xs text-txt3">{{ selected.path }}</p></div><AppButton icon="download" @click="download">下载文件</AppButton></div>
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-elevated/30 px-5 py-3 text-xs text-txt3"><RouterLink :to="`/runs/${selected.runId}`" class="text-accent-2 hover:underline">{{ nameOfRun(selected.runId) }}</RouterLink><span>节点 {{ selected.nodeId }}</span><span>第 {{ selected.attempt }} 次执行</span><time>{{ new Date(selected.createdAt).toLocaleString('zh-CN', { hour12: false }) }}</time></div>
        <div class="px-5 pt-2"><AppTabs v-model="tab" :tabs="[{ id: 'preview', label: '内容预览' }, { id: 'source', label: '源文件' }]" /></div>
        <div class="min-h-[380px] px-6 py-7 sm:px-9">
          <MarkdownContent v-if="tab === 'preview' && selected.contentType === 'text/markdown'" :content="selected.content" />
          <pre v-else class="whitespace-pre-wrap break-words font-mono text-[13px] leading-7 text-txt2">{{ selected.content }}</pre>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.artifact-layout { display: grid; grid-template-columns: minmax(0, 1fr); }
.artifact-directory { background: rgb(var(--c-base) / .5); max-height: 260px; overflow: auto; padding-bottom: 12px; }
.artifact-file { display: flex; align-items: center; gap: 12px; width: calc(100% - 16px); margin: 2px 8px; border-radius: 8px; padding: 12px; text-align: left; }
@media (min-width: 1024px) { .artifact-layout { grid-template-columns: 280px minmax(0, 1fr); } .artifact-directory { max-height: 740px; } }
</style>
