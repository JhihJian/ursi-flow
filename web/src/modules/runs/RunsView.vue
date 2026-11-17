<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { api } from '@/shared/api'
import type { Run, RunStatus } from '@/shared/api/types'
import { useResource } from '@/shared/composables/useResource'
import PageHeader from '@/shared/ui/PageHeader.vue'
import AppButton from '@/shared/ui/AppButton.vue'
import ResourceState from '@/shared/ui/ResourceState.vue'
import StatusPill from '@/shared/ui/StatusPill.vue'
import { formatTime, statusLabels } from './runState'
const route = useRoute()
const { data, loading, error, load } = useResource(signal => api.get<Run[]>('/runs', signal), [])
const search = ref('')
const status = ref(typeof route.query.status === 'string' && route.query.status in statusLabels ? route.query.status : '')
const workflowId = ref(typeof route.query.workflowId === 'string' ? route.query.workflowId : '')
const workflows = computed(() => [...new Map(data.value.map(run => [run.workflowId, run.workflowName])).entries()])
const visible = computed(() => data.value.filter(run => (!status.value || run.status === status.value) && (!workflowId.value || run.workflowId === workflowId.value) && `${run.name} ${run.workflowName} ${run.id}`.toLowerCase().includes(search.value.trim().toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
const filtered = computed(() => !!(search.value || status.value || workflowId.value))
function clear() { search.value = ''; status.value = ''; workflowId.value = '' }
const statuses = Object.entries(statusLabels) as [RunStatus, string][]
</script>
<template>
  <div class="page-stack">
    <PageHeader title="运行记录" description="追踪任务进度，处理人工审批，回看执行过程与交付物。" icon="runs"><template #actions><AppButton variant="outline" icon="refresh" :loading="loading" @click="load">刷新</AppButton><RouterLink to="/workflows" class="text-sm font-medium text-accent-2">前往工作流</RouterLink></template></PageHeader>
    <div class="toolbar">
      <div class="flex w-full flex-wrap gap-3 sm:w-auto"><input v-model="search" class="search-input" type="search" aria-label="搜索运行" placeholder="搜索运行名称、工作流或标识…"><select v-model="status" class="select !w-auto" aria-label="按状态筛选"><option value="">全部状态</option><option v-for="[value, label] in statuses" :key="value" :value="value">{{ label }}</option></select><select v-model="workflowId" class="select !w-auto max-w-[220px]" aria-label="按工作流筛选"><option value="">全部工作流</option><option v-for="[id, name] in workflows" :key="id" :value="id">{{ name }}</option></select></div>
      <span class="text-xs text-txt3">{{ visible.length }} 条运行记录</span>
    </div>
    <ResourceState :loading="loading" :error="error" :empty="!visible.length" :title="error ? undefined : filtered ? '没有匹配的运行' : '暂无运行记录'" :description="error ? undefined : filtered ? '调整筛选条件，查看其他运行。' : '从工作流发起任务后，可以在这里追踪进度。'" @retry="load"><AppButton v-if="filtered" variant="outline" @click="clear">清除筛选</AppButton><RouterLink v-else to="/workflows" class="text-accent-2">选择工作流</RouterLink></ResourceState>
    <div v-if="!loading && !error && visible.length" class="table-wrap"><table class="data-table run-table"><thead><tr><th scope="col">运行</th><th scope="col">状态</th><th scope="col">进度</th><th scope="col">轮次</th><th scope="col">更新时间</th></tr></thead><tbody>
      <tr v-for="run in visible" :key="run.id"><td class="run-name-cell"><RouterLink :to="`/runs/${encodeURIComponent(run.id)}`" class="run-name">{{ run.name }}</RouterLink><p class="mt-1 truncate text-xs text-txt3">{{ run.workflowName }}</p></td><td><StatusPill :status="run.status" /></td><td><div class="flex items-center gap-2"><span class="progress-track"><span :style="{ width: `${run.nodes.length ? run.nodes.filter(node => node.status === 'succeeded').length / run.nodes.length * 100 : 0}%` }" /></span><span class="whitespace-nowrap text-xs text-txt3">{{ run.nodes.filter(node => node.status === 'succeeded').length }}/{{ run.nodes.length }}</span></div></td><td class="whitespace-nowrap text-xs">第 {{ run.attempt }} 次</td><td class="whitespace-nowrap text-xs"><time :datetime="run.updatedAt">{{ formatTime(run.updatedAt) }}</time></td></tr>
    </tbody></table></div>
  </div>
</template>
<style scoped>
.run-table { min-width: 680px; }
.run-name-cell { width: 44%; max-width: 420px; }
.run-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress-track { display: block; width: 64px; height: 4px; overflow: hidden; border-radius: 4px; background: rgb(var(--c-elevated)); }
.progress-track > span { display: block; height: 100%; background: rgb(var(--c-accent)); border-radius: inherit; }
</style>
