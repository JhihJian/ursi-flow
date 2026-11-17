<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, errorMessage } from '@/shared/api'
import type { Workflow } from '@/shared/api/types'
import { useResource } from '@/shared/composables/useResource'
import { confirmAction, notify } from '@/shared/composables/feedback'
import AppButton from '@/shared/ui/AppButton.vue'
import PageHeader from '@/shared/ui/PageHeader.vue'
import ResourceState from '@/shared/ui/ResourceState.vue'
import WorkflowEditor from './WorkflowEditor.vue'
import WorkflowDetail from './WorkflowDetail.vue'
import RunLaunchModal from './RunLaunchModal.vue'
import { formatTime } from './definition'
const { data, loading, error, load } = useResource(signal => api.get<Workflow[]>('/workflows', signal), [])
const search = ref('')
const visible = computed(() => data.value.filter(flow => `${flow.name} ${flow.description}`.toLowerCase().includes(search.value.toLowerCase().trim())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
const editorOpen = ref(false)
const editTarget = ref<Workflow | null>(null)
const detailId = ref('')
const runTarget = ref<Workflow | null>(null)
const savingId = ref('')
const actionError = ref('')
function edit(flow: Workflow | null = null) { detailId.value = ''; editTarget.value = flow; editorOpen.value = true }
function launch(flow: Workflow) { detailId.value = ''; runTarget.value = flow }
function saved() { editorOpen.value = false; void load() }
async function copy(flow: Workflow) {
  if (savingId.value) return
  savingId.value = flow.id; actionError.value = ''
  try {
    if (!await confirmAction({ title: `复制「${flow.name}」？`, description: '创建一份独立的流程定义，随后可以修改名称与节点配置。', confirmLabel: '创建副本' })) return
    const copied = await api.post<Workflow>(`/workflows/${encodeURIComponent(flow.id)}/copy`)
    notify('工作流副本已创建'); await load(); edit(copied)
  } catch (cause) { actionError.value = errorMessage(cause) }
  finally { savingId.value = '' }
}
async function remove(flow: Workflow) {
  if (savingId.value) return
  savingId.value = flow.id; actionError.value = ''
  try {
    if (!await confirmAction({ title: `删除「${flow.name}」？`, description: '删除后无法从该流程创建新运行。已有运行的配置快照仍保留。', danger: true, confirmLabel: '删除工作流' })) return
    await api.delete(`/workflows/${encodeURIComponent(flow.id)}`)
    notify('工作流已删除'); await load()
  } catch (cause) { actionError.value = errorMessage(cause) }
  finally { savingId.value = '' }
}
</script>

<template>
  <div class="page-stack">
    <PageHeader title="工作流" description="管理流程定义，查看节点依赖并发起任务。" icon="workflow"><template #actions><AppButton variant="primary" icon="plus" @click="edit()">新建工作流</AppButton></template></PageHeader>
    <div class="toolbar"><input v-model="search" type="search" class="search-input" placeholder="搜索工作流名称或描述…" aria-label="搜索工作流"><div class="flex items-center gap-3"><span class="text-xs text-txt3">{{ visible.length }} 个工作流</span><AppButton variant="ghost" icon="refresh" :loading="loading" @click="load">刷新</AppButton></div></div>
    <p v-if="actionError" class="rounded-lg border border-err/20 bg-err/5 px-4 py-3 text-sm text-err" role="alert">{{ actionError }}</p>
    <ResourceState :loading="loading" :error="error" :empty="!visible.length" :title="error ? undefined : search ? '没有匹配的工作流' : '创建你的第一个工作流'" :description="error ? undefined : search ? '尝试其他关键词，或清除搜索条件。' : '将智能体、脚本和人工审批连接起来，形成可重复运行的流程。'" @retry="load"><AppButton v-if="search" variant="outline" @click="search = ''">清除搜索</AppButton><AppButton v-else variant="primary" icon="plus" @click="edit()">新建工作流</AppButton></ResourceState>
    <div v-if="!loading && !error && visible.length" class="table-wrap">
      <table class="data-table workflow-table"><thead><tr><th scope="col">名称</th><th scope="col">节点</th><th scope="col">更新时间</th><th scope="col" class="text-right">操作</th></tr></thead>
        <tbody><tr v-for="flow in visible" :key="flow.id">
          <td class="name-cell"><button type="button" class="name-button" @click="detailId = flow.id">{{ flow.name }}</button><p class="flow-description">{{ flow.description || '暂无描述' }}</p></td>
          <td class="whitespace-nowrap text-xs">{{ flow.nodes.length }} 个节点</td><td class="whitespace-nowrap text-xs"><time :datetime="flow.updatedAt">{{ formatTime(flow.updatedAt) }}</time></td>
          <td><div class="flex justify-end gap-1"><AppButton variant="ghost" :disabled="!!savingId" @click="edit(flow)">编辑</AppButton><AppButton variant="subtle" icon="play" :disabled="!!savingId" @click="launch(flow)">运行</AppButton><AppButton variant="ghost" icon="copy" :disabled="!!savingId" :aria-label="`复制 ${flow.name}`" title="复制工作流" @click="copy(flow)" /><AppButton variant="ghost" icon="trash" :disabled="!!savingId" :aria-label="`删除 ${flow.name}`" title="删除工作流" @click="remove(flow)" /></div></td>
        </tr></tbody>
      </table>
    </div>
    <WorkflowEditor v-if="editorOpen" :workflow="editTarget" @close="editorOpen = false" @saved="saved" />
    <WorkflowDetail v-if="detailId" :key="detailId" :id="detailId" @close="detailId = ''" @edit="edit" @run="launch" />
    <RunLaunchModal v-if="runTarget" :workflow="runTarget" @close="runTarget = null" />
  </div>
</template>

<style scoped>
.workflow-table { min-width: 690px; }
.name-cell { width: 48%; max-width: 460px; }
.name-button { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; text-align: left; white-space: nowrap; font-weight: 500; color: rgb(var(--c-txt)); }
.name-button:hover { color: rgb(var(--c-accent-2)); }
.flow-description { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: rgb(var(--c-txt3)); }
</style>
