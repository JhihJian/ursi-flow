<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, errorMessage } from '@/shared/api'
import type { Role, Workflow, WorkflowNode } from '@/shared/api/types'
import { useResource } from '@/shared/composables/useResource'
import { useUnsavedChanges } from '@/shared/composables/useUnsavedChanges'
import { notify } from '@/shared/composables/feedback'
import AppModal from '@/shared/ui/AppModal.vue'
import AppButton from '@/shared/ui/AppButton.vue'
import { parseDefinition } from './definition'
const props = defineProps<{ workflow: Workflow | null }>()
const emit = defineEmits<{ close: []; saved: [workflow: Workflow] }>()
const roles = useResource(signal => api.get<Role[]>('/roles', signal), [])
const name = ref(props.workflow?.name || '')
const description = ref(props.workflow?.description || '')
const nodeJson = ref(JSON.stringify(props.workflow?.nodes || [], null, 2))
const edgeJson = ref(JSON.stringify(props.workflow?.edges || [], null, 2))
const roleId = ref('')
const newType = ref<WorkflowNode['type']>('agent')
const saving = ref(false)
const error = ref('')
const validation = ref('')
const submitted = ref(false)
const serialize = () => JSON.stringify([name.value, description.value, nodeJson.value, edgeJson.value])
let baseline = serialize()
const dirty = computed(() => serialize() !== baseline)
const { canLeave } = useUnsavedChanges(() => dirty.value)
async function close() { if (!saving.value && await canLeave()) emit('close') }
function validate(format = false) {
  error.value = ''; validation.value = ''; submitted.value = true
  if (roles.loading.value || roles.error.value) { error.value = '请先加载角色列表，再校验或保存定义。'; return null }
  try {
    const definition = parseDefinition(name.value, description.value, nodeJson.value, edgeJson.value, roles.data.value)
    if (format) { nodeJson.value = JSON.stringify(definition.nodes, null, 2); edgeJson.value = JSON.stringify(definition.edges, null, 2) }
    validation.value = `校验通过 · ${definition.nodes.length} 个节点，${definition.edges.length} 条连线`
    return definition
  } catch (cause) { error.value = errorMessage(cause); return null }
}
function addNode() {
  error.value = ''; validation.value = ''
  try {
    const nodes: unknown = JSON.parse(nodeJson.value)
    if (!Array.isArray(nodes)) throw new Error('节点必须为数组，请先修正节点 JSON。')
    const chosenRole = roleId.value || roles.data.value[0]?.id
    if (newType.value === 'agent' && !chosenRole) throw new Error('请先创建角色，或选择审批、脚本节点。')
    let index = nodes.length + 1
    while (nodes.some(node => node?.id === `node-${index}`)) index++
    nodes.push({ id: `node-${index}`, name: `节点 ${index}`, type: newType.value, ...(newType.value === 'agent' ? { roleId: chosenRole } : {}), ...(newType.value === 'script' ? { script: 'echo "Hello"' } : {}) })
    nodeJson.value = JSON.stringify(nodes, null, 2)
  } catch (cause) { error.value = errorMessage(cause) }
}
function formatJson() {
  error.value = ''; validation.value = ''
  try {
    const nodes: unknown = JSON.parse(nodeJson.value)
    const edges: unknown = JSON.parse(edgeJson.value)
    nodeJson.value = JSON.stringify(nodes, null, 2)
    edgeJson.value = JSON.stringify(edges, null, 2)
  } catch { error.value = 'JSON 格式不正确，请检查节点和连线中的括号、引号和逗号。' }
}
async function save() {
  if (saving.value) return
  const definition = validate()
  if (!definition) return
  saving.value = true
  try {
    const result = props.workflow
      ? await api.put<Workflow>(`/workflows/${encodeURIComponent(props.workflow.id)}`, definition)
      : await api.post<Workflow>('/workflows', definition)
    baseline = serialize()
    notify(props.workflow ? '工作流已保存' : '工作流已创建')
    emit('saved', result)
  } catch (cause) { error.value = errorMessage(cause) }
  finally { saving.value = false }
}
</script>

<template>
  <AppModal :open="true" :title="workflow ? '编辑工作流' : '新建工作流'" :width="880" @close="close">
    <form id="workflow-editor" class="space-y-5" novalidate @submit.prevent="save">
      <fieldset :disabled="saving" class="space-y-5">
        <label class="field"><span class="field-label">名称 <span class="text-err">*</span></span><input v-model="name" class="input" placeholder="例如：需求分析与交付" autofocus :aria-invalid="submitted && !name.trim()" required><span v-if="submitted && !name.trim()" class="text-xs text-err">请填写工作流名称。</span></label>
        <label class="field"><span class="field-label">描述</span><textarea v-model="description" class="textarea !min-h-[76px]" placeholder="说明这个流程解决什么问题" rows="2" /></label>
        <div class="rounded-lg border border-line bg-elevated/40 p-3">
          <p class="mb-3 text-xs text-txt3">添加节点后，在 JSON 中调整名称和连线。agent 引用角色，approval 等待人工审批，script 保存脚本定义。</p>
          <div class="flex flex-wrap gap-2">
            <select v-model="newType" class="select !w-auto" aria-label="新节点类型"><option value="agent">智能体</option><option value="approval">人工审批</option><option value="script">脚本</option></select>
            <select v-if="newType === 'agent'" v-model="roleId" class="select flex-1" aria-label="新节点默认角色" :disabled="roles.loading.value"><option value="">{{ roles.loading.value ? '正在加载角色…' : '使用第一个可用角色' }}</option><option v-for="role in roles.data.value" :key="role.id" :value="role.id">{{ role.name }} · {{ role.id }}</option></select>
            <AppButton variant="outline" icon="plus" @click="addNode">添加节点</AppButton>
          </div>
          <div v-if="roles.error.value" class="mt-2 flex items-center gap-2 text-xs text-err" role="alert">{{ roles.error.value }}<AppButton variant="ghost" @click="roles.load">重试角色加载</AppButton></div>
          <p v-else-if="!roles.loading.value && !roles.data.value.length" class="mt-2 text-xs text-txt3">暂无角色。可先添加审批或脚本节点，智能体节点需先在角色页面创建角色。</p>
        </div>
        <div class="grid gap-4 md:grid-cols-[1.2fr_1fr]">
          <label class="field"><span class="field-label">节点 JSON <span class="text-err">*</span></span><textarea v-model="nodeJson" class="textarea font-mono !text-xs" rows="13" spellcheck="false" aria-describedby="node-help" @input="validation = ''" /><span id="node-help" class="text-xs text-txt3">每项包含 id、name、type。智能体填写 roleId，脚本填写 script。</span></label>
          <label class="field"><span class="field-label">连线 JSON <span class="text-err">*</span></span><textarea v-model="edgeJson" class="textarea font-mono !text-xs" rows="13" spellcheck="false" aria-describedby="edge-help" @input="validation = ''" /><span id="edge-help" class="text-xs text-txt3">格式：[{ "source": "node-1", "target": "node-2" }]，无连线填写 []。</span></label>
        </div>
        <div class="flex flex-wrap items-center gap-2"><AppButton variant="outline" icon="terminal" @click="formatJson">格式化 JSON</AppButton><AppButton variant="ghost" icon="check" @click="validate(true)">校验定义</AppButton><span v-if="validation" class="text-xs text-ok" role="status">{{ validation }}</span></div>
      </fieldset>
      <p v-if="error" class="rounded-lg border border-err/20 bg-err/5 px-3 py-2 text-sm text-err" role="alert">{{ error }}</p>
    </form>
    <template #footer><span v-if="dirty" class="mr-auto text-xs text-txt3">有未保存的更改</span><AppButton variant="ghost" :disabled="saving" @click="close">取消</AppButton><AppButton variant="primary" type="submit" form="workflow-editor" :loading="saving" :disabled="roles.loading.value || !!roles.error.value">{{ workflow ? '保存更改' : '创建工作流' }}</AppButton></template>
  </AppModal>
</template>
