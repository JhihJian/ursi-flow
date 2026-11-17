<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorMessage } from '@/shared/api'
import type { Run, Workflow } from '@/shared/api/types'
import { notify } from '@/shared/composables/feedback'
import { useUnsavedChanges } from '@/shared/composables/useUnsavedChanges'
import AppModal from '@/shared/ui/AppModal.vue'
import AppButton from '@/shared/ui/AppButton.vue'
const props = defineProps<{ workflow: Workflow }>()
const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const name = ref('')
const input = ref('')
const saving = ref(false)
const error = ref('')
const submitted = ref(false)
const launched = ref(false)
const { canLeave } = useUnsavedChanges(() => !launched.value && !!(name.value || input.value))
async function close() { if (!saving.value && await canLeave()) emit('close') }
async function launch() {
  if (saving.value) return
  submitted.value = true; error.value = ''
  if (!input.value.trim()) { error.value = '请填写任务输入，说明本次运行需要完成的工作。'; return }
  saving.value = true
  try {
    const run = await api.post<Run>('/runs', { workflowId: props.workflow.id, input: input.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}) })
    launched.value = true
    notify('运行已创建')
    emit('close')
    await router.push(`/runs/${encodeURIComponent(run.id)}`)
  } catch (cause) { error.value = errorMessage(cause) }
  finally { saving.value = false }
}
</script>
<template>
  <AppModal :open="true" title="运行工作流" :width="600" @close="close">
    <form id="launch-run" class="space-y-5" novalidate @submit.prevent="launch">
      <div class="rounded-lg border border-line bg-elevated/40 px-4 py-3"><p class="font-medium">{{ workflow.name }}</p><p class="mt-1 text-xs text-txt3">{{ workflow.nodes.length }} 个节点 · 创建时保存流程与角色配置快照</p></div>
      <label class="field"><span class="field-label">运行名称 <span class="font-normal text-txt3">（可选）</span></span><input v-model="name" class="input" placeholder="留空使用默认名称" :disabled="saving"></label>
      <label class="field"><span class="field-label">任务输入 <span class="text-err">*</span></span><textarea v-model="input" class="textarea" rows="6" placeholder="描述目标、背景、输入材料和期望交付内容…" autofocus :disabled="saving" :aria-invalid="submitted && !input.trim()" required /></label>
      <p v-if="error" role="alert" class="text-sm text-err">{{ error }}</p>
    </form>
    <template #footer><AppButton variant="ghost" :disabled="saving" @click="close">取消</AppButton><AppButton type="submit" form="launch-run" variant="primary" icon="play" :loading="saving">开始运行</AppButton></template>
  </AppModal>
</template>
