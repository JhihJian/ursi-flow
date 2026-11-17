<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { api, errorMessage } from '@/shared/api'
import type { Sandbox } from '@/shared/api/types'
import { useResource } from '@/shared/composables/useResource'
import { confirmAction, notify } from '@/shared/composables/feedback'
import AppButton from '@/shared/ui/AppButton.vue'
import AppModal from '@/shared/ui/AppModal.vue'
import Icon from '@/shared/ui/Icon.vue'
import PageHeader from '@/shared/ui/PageHeader.vue'
import ResourceState from '@/shared/ui/ResourceState.vue'
import StatusPill from '@/shared/ui/StatusPill.vue'

const route = useRoute()
const { data, loading, error, load } = useResource((signal) => api.get<Sandbox[]>('/sandboxes', signal), [])
const search = ref('')
const filter = ref('')
const selectedId = ref(typeof route.query.id === 'string' ? route.query.id : '')
const selected = computed(() => data.value.find((item) => item.id === selectedId.value))
const filtered = computed(() => data.value.filter((item) => (!filter.value || item.status === filter.value) && `${item.name} ${item.id}`.toLowerCase().includes(search.value.toLowerCase())))
const releasing = ref('')
async function release(item: Sandbox) {
  if (!await confirmAction({ title: '释放沙箱？', description: `将释放「${item.name}」的演示资源。已回收的产物仍可查询，正在执行任务的沙箱会拒绝释放。`, confirmLabel: '释放沙箱', danger: true })) return
  releasing.value = item.id
  try { await api.post(`/sandboxes/${item.id}/release`); await load(); notify('沙箱已释放') }
  catch (cause) { notify(errorMessage(cause), 'error') }
  finally { releasing.value = '' }
}
</script>

<template>
  <div class="page-stack">
    <PageHeader title="沙箱管理" description="独立运行环境，清晰掌握每个任务的资源与生命周期。" icon="server"><template #actions><AppButton icon="refresh" :loading="loading" @click="load">刷新状态</AppButton></template></PageHeader>
    <div class="grid grid-cols-3 gap-3 sm:gap-5">
      <div v-for="metric in [{ label: '全部环境', value: data.length, icon: 'server' }, { label: '使用中', value: data.filter(item => item.status === 'running').length, icon: 'play' }, { label: '已释放', value: data.filter(item => item.status === 'released').length, icon: 'check' }]" :key="metric.label" class="panel px-4 py-4 sm:px-5"><div class="flex items-center justify-between text-xs text-txt3"><span>{{ metric.label }}</span><Icon :name="metric.icon" :size="15" class="hidden sm:inline" /></div><p class="mt-3 text-2xl font-semibold tabular-nums">{{ metric.value }}</p></div>
    </div>
    <div class="toolbar"><label class="search-input"><Icon name="search" :size="16" /><input v-model="search" type="search" aria-label="搜索沙箱" placeholder="搜索沙箱名称或标识…" /></label><select v-model="filter" aria-label="沙箱状态" class="select !w-auto"><option value="">全部状态</option><option value="running">使用中</option><option value="released">已释放</option><option value="failed">失败</option></select></div>
    <ResourceState :loading="loading" :error="error" :empty="!filtered.length" title="没有找到沙箱" description="发起流程运行后，演示服务会自动准备对应环境。" @retry="load" />
    <div v-if="!loading && !error && filtered.length" class="grid gap-4 xl:grid-cols-2">
      <article v-for="item in filtered" :key="item.id" class="panel overflow-hidden">
        <div class="flex items-start gap-3 p-5"><span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-elevated text-txt2"><Icon name="server" :size="22" /></span><div class="min-w-0 flex-1"><button type="button" class="max-w-full truncate text-left font-semibold hover:text-accent-2" @click="selectedId = item.id">{{ item.name }}</button><p class="mt-1 truncate font-mono text-xs text-txt3">{{ item.id }}</p></div><StatusPill :status="item.status" /></div>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-4 px-5 pb-5 text-xs"><div><dt class="text-txt3">镜像</dt><dd class="mt-1.5 break-all font-medium">{{ item.image }}</dd></div><div><dt class="text-txt3">资源规格</dt><dd class="mt-1.5 font-medium">{{ item.cpu }} / {{ item.memory }}</dd></div><div><dt class="text-txt3">工作目录</dt><dd class="mt-1.5 break-all font-mono">{{ item.workspace }}</dd></div><div><dt class="text-txt3">创建时间</dt><dd class="mt-1.5">{{ new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }) }}</dd></div></dl>
        <footer class="flex flex-wrap items-center gap-2 border-t border-line bg-elevated/25 px-5 py-3"><RouterLink :to="`/runs/${item.runId}`" class="mr-auto text-xs font-medium text-accent-2 hover:underline">查看关联运行 <span aria-hidden="true">↗</span></RouterLink><AppButton variant="ghost" size="sm" icon="file" @click="selectedId = item.id">详情与日志</AppButton><AppButton v-if="item.status !== 'released'" size="sm" variant="danger" :loading="releasing === item.id" @click="release(item)">释放</AppButton></footer>
      </article>
    </div>
    <p class="text-xs leading-6 text-txt3">演示环境只模拟资源状态和操作记录，不建立真实终端或远程连接。</p>
    <AppModal :open="!!selected" :title="selected?.name" :width="720" @close="selectedId = ''">
      <template v-if="selected"><div class="mb-5 flex items-center justify-between"><span class="font-mono text-xs text-txt3">{{ selected.id }}</span><StatusPill :status="selected.status" /></div><h3 class="mb-3 text-sm font-medium">生命周期记录</h3><div class="rounded-lg border border-line bg-base p-4"><pre class="whitespace-pre-wrap break-words font-mono text-xs leading-7 text-txt2">{{ selected.logs.join('\n') }}</pre></div><p class="mt-4 text-xs text-txt3">日志为本地演示事件，保留环境准备与释放记录。</p></template>
      <template #footer><AppButton @click="selectedId = ''">关闭</AppButton></template>
    </AppModal>
  </div>
</template>
