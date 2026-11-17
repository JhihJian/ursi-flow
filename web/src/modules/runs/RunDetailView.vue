<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import AppButton from '@/shared/ui/AppButton.vue'
import AppModal from '@/shared/ui/AppModal.vue'
import AppTabs from '@/shared/ui/AppTabs.vue'
import Icon from '@/shared/ui/Icon.vue'
import PageHeader from '@/shared/ui/PageHeader.vue'
import ResourceState from '@/shared/ui/ResourceState.vue'
import StatusPill from '@/shared/ui/StatusPill.vue'
import { confirmAction, notify } from '@/shared/composables/feedback'
import RunSnapshot from './RunSnapshot.vue'
import { useRunDetail } from './useRunDetail'
import { completedAncestors, formatTime, isTerminal } from './runState'
const route = useRoute()
const { run, events, artifacts, loading, refreshing, error, artifactError, actionError, saving, load, act } = useRunDetail(() => String(route.params.id))
const tab = ref('activity')
const selectedNode = ref('')
const eventKind = ref('')
const rejectOpen = ref(false)
const targetNodeId = ref('')
const rejectError = ref('')
const confirming = ref(false)
const tabs = [{ id: 'activity', label: '执行过程' }, { id: 'input', label: '任务输入' }, { id: 'snapshot', label: '配置快照' }, { id: 'artifacts', label: '交付产物' }]
const ancestors = computed(() => run.value ? completedAncestors(run.value) : [])
const approval = computed(() => run.value?.nodes.find(node => node.status === 'waiting_approval'))
const selected = computed(() => run.value?.nodes.find(node => node.id === selectedNode.value))
const visibleEvents = computed(() => events.value.filter(event => (!selectedNode.value || event.nodeId === selectedNode.value) && (!eventKind.value || event.type === eventKind.value)))
const completedCount = computed(() => run.value?.nodes.filter(node => node.status === 'succeeded').length || 0)
const busy = computed(() => saving.value || confirming.value)
const eventLabel = { state: '状态', log: '日志', tool: '工具' }
const nodeLabel = { agent: '智能体', approval: '人工审批', script: '脚本' }
watch(() => route.params.id, () => { selectedNode.value = ''; tab.value = 'activity'; rejectOpen.value = false; targetNodeId.value = ''; rejectError.value = ''; confirming.value = false })
async function approve() {
  if (busy.value || !run.value) return
  if (await act('approve')) notify('审批已通过')
}
function openReject() {
  if (busy.value) return
  targetNodeId.value = ancestors.value[0]?.id || ''; rejectError.value = ''; actionError.value = ''; rejectOpen.value = true
}
async function reject() {
  if (busy.value) return
  if (!ancestors.value.some(node => node.id === targetNodeId.value)) { rejectError.value = '请选择已完成的上游祖先节点。'; return }
  if (await act('reject', { targetNodeId: targetNodeId.value })) { rejectOpen.value = false; notify('已打回，新的执行轮次已创建') }
}
async function cancel() {
  if (busy.value || !run.value) return
  const id = run.value.id
  confirming.value = true
  try {
    const accepted = await confirmAction({ title: '取消这次运行？', description: '确认后请求停止执行，已产生的事件与产物会保留。', danger: true, confirmLabel: '取消运行' })
    if (accepted && run.value?.id === id && await act('cancel')) notify('取消请求已处理')
  } finally { confirming.value = false }
}
function eventTime(nodeId: string) { return [...events.value].reverse().find(event => event.nodeId === nodeId)?.at }
</script>

<template>
  <div class="page-stack">
    <div class="flex flex-wrap items-center justify-between gap-2"><RouterLink to="/runs" class="inline-flex items-center gap-1 text-xs text-txt3 hover:text-accent-2"><Icon name="chevron-left" :size="14" />运行记录</RouterLink><span v-if="run && !isTerminal(run.status)" class="inline-flex items-center gap-2 text-xs text-txt3"><span class="h-1.5 w-1.5 rounded-full bg-accent" />每 1.5 秒更新</span><span v-else-if="run" class="text-xs text-txt3">运行已结束</span></div>
    <PageHeader :title="run?.name || '运行详情'" :description="run?.workflowName || '查看运行状态、执行过程与配置快照。'" icon="runs"><template #actions><AppButton variant="ghost" icon="refresh" :loading="refreshing" :disabled="busy" @click="load(true)">刷新</AppButton><AppButton v-if="run && !isTerminal(run.status)" variant="outline" :disabled="busy" @click="cancel">取消运行</AppButton></template></PageHeader>
    <ResourceState v-if="!run" :loading="loading" :error="error" @retry="load(true)" />
    <div v-if="error && run" class="notice error" role="alert"><span>更新失败，当前显示上次读取的状态。{{ error }}</span><AppButton variant="ghost" @click="load(true)">重试</AppButton></div>
    <p v-if="actionError && !rejectOpen" class="notice error" role="alert">{{ actionError }}</p>
    <div v-if="run" class="detail-layout">
      <main class="min-w-0 space-y-5" aria-label="运行内容">
        <section v-if="run.status === 'waiting' && approval" class="approval-panel">
          <div class="flex min-w-0 items-start gap-3"><span class="rounded-lg bg-accent-dim p-2 text-accent-2"><Icon name="gate" :size="19" /></span><div><h2 class="text-sm font-semibold">等待人工审批</h2><p class="mt-1 text-xs leading-6 text-txt3">「{{ approval.name }}」需要你的决定。查看上游输出后，可以放行或打回返工。</p></div></div>
          <div class="mt-4 flex flex-wrap justify-end gap-2"><AppButton variant="outline" :disabled="busy || !ancestors.length" @click="openReject">打回返工</AppButton><AppButton variant="primary" icon="check" :loading="saving" :disabled="confirming" @click="approve">通过审批</AppButton></div>
          <p v-if="!ancestors.length" class="mt-2 text-xs text-txt3">当前没有已完成的上游节点可供打回。</p>
        </section>
        <section class="panel overflow-hidden">
          <div class="section-heading"><h2>节点步骤</h2><span>第 {{ run.attempt }} 次执行 · {{ completedCount }}/{{ run.nodes.length }} 完成</span></div>
          <ol class="node-timeline">
            <li v-for="(node, index) in run.nodes" :key="node.id">
              <button type="button" class="step-row" :class="{ 'step-selected': selectedNode === node.id }" :aria-pressed="selectedNode === node.id" @click="selectedNode = selectedNode === node.id ? '' : node.id; tab = 'activity'">
                <span class="step-number" :class="{ 'step-done': node.status === 'succeeded', 'step-active': ['running', 'waiting_approval'].includes(node.status) }"><Icon v-if="node.status === 'succeeded'" name="check" :size="14" /><span v-else>{{ index + 1 }}</span></span>
                <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{{ node.name }}</span><span class="mt-0.5 block text-xs text-txt3">{{ nodeLabel[node.type] }}<template v-if="node.roleId"> · {{ run.snapshot.roles.find(role => role.id === node.roleId)?.name || node.roleId }}</template></span></span>
                <time v-if="eventTime(node.id)" :datetime="eventTime(node.id)" class="hidden text-[11px] text-txt3 sm:block">{{ formatTime(eventTime(node.id)!) }}</time><StatusPill :status="node.status" />
              </button>
            </li>
          </ol>
          <div v-if="selected" class="border-t border-line bg-elevated/30 p-4"><div class="flex items-center justify-between gap-3"><h3 class="text-xs font-medium">{{ selected.name }} · 当前输出</h3><button type="button" class="text-xs text-accent-2" @click="selectedNode = ''">显示全部节点</button></div><pre class="mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-txt3">{{ selected.output || '当前节点尚未产生输出。' }}</pre></div>
        </section>
        <section class="panel overflow-hidden">
          <div class="border-b border-line px-4 pt-2"><AppTabs v-model="tab" :tabs="tabs" /></div>
          <div v-if="tab === 'activity'">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3"><span class="text-xs text-txt3">{{ selected ? selected.name : '全部节点' }} · {{ visibleEvents.length }} 条事件</span><select v-model="eventKind" aria-label="筛选事件类型" class="select !w-auto !py-1 !text-xs"><option value="">全部事件</option><option value="state">状态变化</option><option value="tool">工具轨迹</option><option value="log">执行日志</option></select></div>
            <div v-if="!visibleEvents.length" class="empty-hint">暂无符合条件的事件，运行更新后会显示在这里。</div>
            <ol v-else class="event-list" aria-label="运行事件日志"><li v-for="event in visibleEvents" :key="event.id" class="event-row"><span class="event-sequence">{{ String(event.sequence).padStart(3, '0') }}</span><div class="min-w-0"><div class="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-txt3"><time :datetime="event.at">{{ formatTime(event.at) }}</time><span class="event-kind">{{ eventLabel[event.type] }}</span><span v-if="event.nodeId">{{ run.nodes.find(node => node.id === event.nodeId)?.name || event.nodeId }}</span></div><p class="whitespace-pre-wrap break-words text-xs leading-6 text-txt2">{{ event.message }}</p></div></li></ol>
          </div>
          <div v-else-if="tab === 'input'" class="p-5"><h2 class="mb-3 text-sm font-medium">任务输入</h2><pre class="whitespace-pre-wrap break-words text-sm leading-7 text-txt2">{{ run.input || '无任务输入' }}</pre></div>
          <div v-else-if="tab === 'snapshot'" class="p-5"><RunSnapshot :snapshot="run.snapshot" /></div>
          <div v-else-if="tab === 'artifacts'" class="p-4">
            <div class="mb-4 flex items-center justify-between gap-2"><p class="text-xs text-txt3">保留当前与历史轮次的交付产物。</p><RouterLink :to="{ path: '/artifacts', query: { runId: run.id } }" class="text-xs text-accent-2">查看全部产物</RouterLink></div>
            <div v-if="artifactError" class="notice error" role="alert">{{ artifactError }}<AppButton variant="ghost" @click="load(true)">重试</AppButton></div>
            <p v-else-if="!artifacts.length" class="empty-hint">尚未产生交付物。</p>
            <ul v-else class="divide-y divide-line"><li v-for="artifact in artifacts" :key="artifact.id" class="flex items-center gap-3 py-3"><Icon name="doc" :size="18" class="shrink-0 text-txt3" /><div class="min-w-0 flex-1"><RouterLink :to="{ path: '/artifacts', query: { runId: run.id, id: artifact.id } }" class="block truncate text-sm font-medium hover:text-accent-2">{{ artifact.name }}</RouterLink><p class="mt-1 text-xs text-txt3">第 {{ artifact.attempt }} 次执行 · {{ run.nodes.find(node => node.id === artifact.nodeId)?.name || artifact.nodeId }} · {{ artifact.size < 1024 ? `${artifact.size} B` : `${(artifact.size / 1024).toFixed(1)} KB` }}</p></div><time class="hidden text-xs text-txt3 sm:block" :datetime="artifact.createdAt">{{ formatTime(artifact.createdAt) }}</time></li></ul>
          </div>
        </section>
      </main>
      <aside class="space-y-4" aria-label="运行摘要">
        <section class="panel p-5"><div class="mb-5 flex items-center justify-between"><h2 class="text-sm font-semibold">运行摘要</h2><StatusPill :status="run.status" /></div><dl class="summary-list"><dt>运行标识</dt><dd class="font-mono text-[11px]">{{ run.id }}</dd><dt>工作流</dt><dd>{{ run.workflowName }}</dd><dt>执行轮次</dt><dd>第 {{ run.attempt }} 次</dd><dt>创建时间</dt><dd>{{ formatTime(run.createdAt) }}</dd><dt>最近更新</dt><dd>{{ formatTime(run.updatedAt) }}</dd><dt>节点完成</dt><dd>{{ completedCount }} / {{ run.nodes.length }}</dd></dl></section>
        <section class="panel p-4"><h2 class="mb-3 text-xs font-semibold text-txt3">关联资源</h2><RouterLink :to="{ path: '/artifacts', query: { runId: run.id } }" class="resource-link"><span><Icon name="folder" :size="16" />交付产物</span><span>{{ artifactError ? '查看' : artifacts.length }}<Icon name="chevron-right" :size="14" /></span></RouterLink><RouterLink v-if="run.sandboxId" :to="{ path: '/sandboxes', query: { id: run.sandboxId } }" class="resource-link"><span><Icon name="terminal" :size="16" />运行沙箱</span><Icon name="chevron-right" :size="14" /></RouterLink><button type="button" class="resource-link w-full" @click="tab = 'snapshot'"><span><Icon name="settings" :size="16" />配置快照</span><Icon name="chevron-right" :size="14" /></button></section>
      </aside>
    </div>
    <AppModal :open="rejectOpen" title="打回上游节点" :width="520" @close="!saving && (rejectOpen = false)">
      <form id="reject-run" class="space-y-4" @submit.prevent="reject"><p class="text-sm leading-6 text-txt3">选择已完成的上游环节。该节点及其下游将重新执行，历史事件和产物会保留。</p><label class="field"><span class="field-label">返工目标 <span class="text-err">*</span></span><select v-model="targetNodeId" class="select" :disabled="saving" required><option value="" disabled>请选择上游节点</option><option v-for="node in ancestors" :key="node.id" :value="node.id">{{ node.name }}</option></select></label><p v-if="!ancestors.length" class="text-xs text-txt3">状态已变化，当前没有可用的返工目标。请关闭后查看最新状态。</p><p v-if="rejectError || actionError" class="text-sm text-err" role="alert">{{ rejectError || actionError }}</p></form>
      <template #footer><AppButton variant="ghost" :disabled="saving" @click="rejectOpen = false">取消</AppButton><AppButton variant="primary" type="submit" form="reject-run" :loading="saving" :disabled="!ancestors.length || run?.status !== 'waiting'">确认打回</AppButton></template>
    </AppModal>
  </div>
</template>

<style scoped>
.detail-layout { display: grid; grid-template-columns: minmax(0, 1fr) 288px; gap: 24px; align-items: start; }
.notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid rgb(var(--c-line)); border-radius: 8px; padding: 12px 16px; font-size: 12px; }
.notice.error { border-color: rgb(var(--c-err) / .2); background: rgb(var(--c-err) / .04); color: rgb(var(--c-err)); }
.approval-panel { border: 1px solid rgb(var(--c-accent) / .3); border-radius: 12px; background: rgb(var(--c-surface)); padding: 20px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 16px 20px; border-bottom: 1px solid rgb(var(--c-line)); }
.section-heading h2 { font-size: 13px; font-weight: 600; }
.section-heading > span { font-size: 11px; color: rgb(var(--c-txt3)); }
.node-timeline { padding: 8px; }
.step-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px; border-radius: 8px; text-align: left; }
.step-row:hover, .step-selected { background: rgb(var(--c-elevated) / .7); }
.step-number { display: flex; width: 28px; height: 28px; flex-shrink: 0; justify-content: center; align-items: center; border-radius: 50%; border: 1px solid rgb(var(--c-line-strong)); color: rgb(var(--c-txt3)); font-size: 11px; }
.step-done { border-color: rgb(var(--c-accent) / .25); color: rgb(var(--c-accent-2)); background: rgb(var(--c-accent-dim)); }
.step-active { border-color: rgb(var(--c-accent)); color: rgb(var(--c-accent-2)); }
.event-list { max-height: 560px; overflow: auto; padding: 4px 0; }
.event-row { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 12px 20px; border-bottom: 1px solid rgb(var(--c-line) / .5); }
.event-row:last-child { border-bottom: 0; }
.event-sequence { padding-top: 2px; font-family: monospace; font-size: 10px; color: rgb(var(--c-txt3)); }
.event-kind { padding: 0 5px; border-radius: 3px; background: rgb(var(--c-elevated)); }
.summary-list { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 16px 12px; font-size: 12px; }
.summary-list dt { color: rgb(var(--c-txt3)); }
.summary-list dd { overflow-wrap: anywhere; }
.resource-link { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 4px; font-size: 12px; color: rgb(var(--c-txt2)); }
.resource-link:hover { color: rgb(var(--c-accent-2)); }
.resource-link span { display: flex; align-items: center; gap: 8px; }
@media (max-width: 1100px) { .detail-layout { grid-template-columns: minmax(0, 1fr) 245px; gap: 16px; } }
@media (max-width: 800px) { .detail-layout { grid-template-columns: minmax(0, 1fr); } .summary-list { grid-template-columns: 80px minmax(0, 1fr); } }
@media (max-width: 480px) { .step-row { gap: 8px; padding: 10px 6px; } .event-row { padding: 10px 12px; gap: 8px; grid-template-columns: 25px minmax(0, 1fr); } }
</style>
