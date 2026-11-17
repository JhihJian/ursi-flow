<script setup lang="ts">
import { api } from '@/shared/api'
import type { Workflow, Role } from '@/shared/api/types'
import { useResource } from '@/shared/composables/useResource'
import AppModal from '@/shared/ui/AppModal.vue'
import AppButton from '@/shared/ui/AppButton.vue'
import ResourceState from '@/shared/ui/ResourceState.vue'
import WorkflowDiagram from './WorkflowDiagram.vue'
import { formatTime } from './definition'
const props = defineProps<{ id: string }>()
defineEmits<{ close: []; edit: [workflow: Workflow]; run: [workflow: Workflow] }>()
const { data, loading, error, load } = useResource(signal => api.get<Workflow>(`/workflows/${encodeURIComponent(props.id)}`, signal), null)
const roles = useResource(signal => api.get<Role[]>('/roles', signal), [])
</script>
<template>
  <AppModal :open="true" :title="data?.name || '工作流详情'" :width="960" @close="$emit('close')">
    <ResourceState :loading="loading" :error="error" @retry="load" />
    <div v-if="data && !loading && !error" class="space-y-5">
      <p class="text-sm leading-6 text-txt3">{{ data.description || '暂无描述' }}</p>
      <div class="flex flex-wrap gap-4 text-xs text-txt3"><span>{{ data.nodes.length }} 个节点</span><span>{{ data.edges.length }} 条连线</span><span>更新于 {{ formatTime(data.updatedAt) }}</span></div>
      <div class="overflow-hidden rounded-lg border border-line"><WorkflowDiagram :workflow="data" :roles="roles.data.value" /></div>
      <p v-if="roles.error.value" class="text-xs text-txt3">角色名称暂时无法加载，节点仍显示角色标识。<button type="button" class="text-accent-2" @click="roles.load">重试</button></p>
    </div>
    <template #footer><AppButton variant="ghost" @click="$emit('close')">关闭</AppButton><AppButton :disabled="!data || loading || !!error" icon="edit" @click="data && $emit('edit', data)">编辑定义</AppButton><AppButton variant="primary" icon="play" :disabled="!data || loading || !!error" @click="data && $emit('run', data)">运行</AppButton></template>
  </AppModal>
</template>
