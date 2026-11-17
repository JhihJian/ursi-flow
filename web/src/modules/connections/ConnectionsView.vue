<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, errorMessage } from '@/shared/api'
import type { Connection } from '@/shared/api/types'
import { useResource } from '@/shared/composables/useResource'
import { confirmAction, notify } from '@/shared/composables/feedback'
import { useUnsavedChanges } from '@/shared/composables/useUnsavedChanges'
import Icon from '@/shared/ui/Icon.vue'
import AppButton from '@/shared/ui/AppButton.vue'
import AppModal from '@/shared/ui/AppModal.vue'
import PageHeader from '@/shared/ui/PageHeader.vue'
import ResourceState from '@/shared/ui/ResourceState.vue'

const { data: connections, loading, error, load } = useResource((signal) => api.get<Connection[]>('/connections', signal), [])
const query = ref('')
const filtered = computed(() => connections.value.filter((item) => `${item.name} ${item.provider} ${item.model} ${item.baseUrl}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const providers = computed(() => new Set(connections.value.map((item) => item.provider)).size)
const draft = ref<Connection | null>(null)
const baseline = ref('')
const saving = ref(false)
const formError = ref('')
const actionError = ref('')
const deleting = ref('')
const testing = ref(new Set<string>())
const results = ref<Record<string, { ok: boolean; message: string; latency?: number }>>({})
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== baseline.value)
const { canLeave } = useUnsavedChanges(() => dirty.value)

function openEditor(connection?: Connection) {
  draft.value = connection ? { ...connection } : { id: '', name: '', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', credentialRef: '', updatedAt: '' }
  baseline.value = JSON.stringify(draft.value)
  formError.value = ''
}
async function closeEditor() {
  if (!saving.value && await canLeave()) draft.value = null
}
async function save() {
  if (!draft.value || saving.value) return
  formError.value = ''
  const payload = { ...draft.value, name: draft.value.name.trim(), provider: draft.value.provider.trim(), baseUrl: draft.value.baseUrl.trim(), model: draft.value.model.trim(), credentialRef: draft.value.credentialRef.trim() }
  if (!payload.name || !payload.provider || !payload.model) { formError.value = '请填写连接名称、服务提供方和模型名称。'; return }
  try {
    const url = new URL(payload.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
  } catch { formError.value = '请填写有效的 HTTP(S) 服务地址，地址中不能包含账号、密码、查询参数或片段。'; return }
  saving.value = true
  try {
    const saved = payload.id ? await api.put<Connection>(`/connections/${encodeURIComponent(payload.id)}`, payload) : await api.post<Connection>('/connections', payload)
    connections.value = payload.id ? connections.value.map((item) => item.id === saved.id ? saved : item) : [...connections.value, saved]
    delete results.value[saved.id]
    draft.value = null
    notify(payload.id ? '连接配置已保存' : '连接已创建')
  } catch (cause) { formError.value = errorMessage(cause) }
  finally { saving.value = false }
}
async function test(connection: Connection) {
  if (testing.value.has(connection.id)) return
  testing.value.add(connection.id)
  delete results.value[connection.id]
  try {
    results.value[connection.id] = await api.post<{ ok: boolean; message: string; latency: number }>(`/connections/${encodeURIComponent(connection.id)}/test`)
  } catch (cause) { results.value[connection.id] = { ok: false, message: errorMessage(cause) } }
  finally { testing.value.delete(connection.id) }
}
async function remove(connection: Connection) {
  if (deleting.value || !await confirmAction({ title: `删除「${connection.name}」？`, description: '删除后无法恢复。被角色引用的连接需要先解除引用。', danger: true, confirmLabel: '删除连接' })) return
  deleting.value = connection.id
  actionError.value = ''
  try {
    await api.delete(`/connections/${encodeURIComponent(connection.id)}`)
    connections.value = connections.value.filter((item) => item.id !== connection.id)
    delete results.value[connection.id]
    notify('连接已删除')
  } catch (cause) { actionError.value = errorMessage(cause); notify(actionError.value, 'error') }
  finally { deleting.value = '' }
}
</script>

<template>
  <div class="page-stack connections-page">
    <PageHeader title="模型连接" description="统一管理模型服务，让每个角色连接合适的智能。" icon="connector">
      <template #actions><AppButton variant="primary" icon="plus" @click="openEditor()">新建连接</AppButton></template>
    </PageHeader>
    <div class="connection-intro panel bg-surface border-line">
      <div class="intro-icon bg-accent/10 text-accent"><Icon name="connector" :size="25" /></div>
      <div class="intro-copy"><h2 class="text-txt">模型服务，集中配置</h2><p class="text-txt3">角色通过连接引用模型。凭据仅保存引用标识，由执行环境解析。</p></div>
      <div class="intro-stat"><strong class="text-txt">{{ connections.length }}</strong><span class="text-txt3">模型连接</span></div>
      <div class="intro-stat"><strong class="text-txt">{{ providers }}</strong><span class="text-txt3">服务提供方</span></div>
    </div>
    <div class="toolbar connection-toolbar">
      <div class="search-input"><Icon name="search" :size="16" /><input v-model="query" aria-label="搜索连接" placeholder="搜索名称、模型或服务地址…" /></div>
      <span class="text-txt3 count">{{ filtered.length }} 个连接</span>
      <AppButton variant="ghost" size="sm" icon="refresh" :disabled="loading" @click="load">刷新</AppButton>
    </div>
    <p v-if="actionError" role="alert" class="error-banner text-err bg-err/10">{{ actionError }}</p>
    <ResourceState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <div v-else-if="!connections.length" class="panel">
      <ResourceState empty title="连接你的第一个模型" description="添加服务地址与凭据引用，即可在角色工作室中选择。" />
      <div class="empty-action"><AppButton icon="plus" @click="openEditor()">新建连接</AppButton></div>
    </div>
    <div v-else-if="!filtered.length" class="panel">
      <ResourceState empty title="没有匹配的连接" description="试试其他名称、服务提供方或模型关键词。" />
      <div class="empty-action"><AppButton variant="outline" @click="query = ''">清空搜索</AppButton></div>
    </div>
    <div v-else class="connection-grid">
      <article v-for="connection in filtered" :key="connection.id" class="connection-card panel bg-surface border-line">
        <div class="card-heading"><div class="provider-mark bg-elevated text-accent">{{ connection.provider.slice(0, 2).toUpperCase() }}</div><div class="card-title"><h2 class="text-txt">{{ connection.name }}</h2><span class="provider text-txt3">{{ connection.provider }}</span></div><span class="config-badge border-line text-txt3">已配置</span></div>
        <dl class="connection-details"><div><dt class="text-txt3">模型</dt><dd class="text-txt"><Icon name="brain" :size="14" />{{ connection.model }}</dd></div><div><dt class="text-txt3">服务地址</dt><dd class="text-txt2 endpoint">{{ connection.baseUrl }}</dd></div><div><dt class="text-txt3">凭据引用</dt><dd class="text-txt2"><Icon name="lock" :size="13" />{{ connection.credentialRef || '未设置' }}</dd></div></dl>
        <div v-if="results[connection.id]" class="test-result" :class="results[connection.id]?.ok ? 'text-ok bg-ok/10' : 'text-err bg-err/10'" role="status"><strong>模拟连接验证 · {{ results[connection.id]?.ok ? '通过' : '未通过' }}</strong><span>{{ results[connection.id]?.message }}</span><span v-if="results[connection.id]?.latency !== undefined">模拟耗时 {{ results[connection.id]?.latency }} ms</span></div>
        <div class="card-footer border-line"><AppButton variant="outline" size="sm" icon="play" :loading="testing.has(connection.id)" :disabled="deleting === connection.id" @click="test(connection)">模拟验证</AppButton><div class="card-actions"><AppButton variant="ghost" size="sm" icon="edit" :disabled="testing.has(connection.id) || deleting === connection.id" @click="openEditor(connection)">编辑</AppButton><AppButton variant="ghost" size="sm" icon="trash" :aria-label="`删除 ${connection.name}`" :loading="deleting === connection.id" :disabled="!!deleting || testing.has(connection.id)" @click="remove(connection)" /></div></div>
      </article>
    </div>
    <p class="simulation-note text-txt3"><Icon name="info" :size="14" />模拟连接验证用于检查演示配置，不代表真实模型认证或网络连通性。</p>
    <AppModal :open="!!draft" :title="draft?.id ? '编辑模型连接' : '新建模型连接'" :width="600" @close="closeEditor">
      <form v-if="draft" id="connection-form" class="connection-form" @submit.prevent="save">
        <p class="text-txt3 form-intro">设置模型的访问方式，供角色统一引用。</p>
        <p v-if="formError" role="alert" class="error-banner text-err bg-err/10">{{ formError }}</p>
        <fieldset :disabled="saving" class="form-fields">
          <label class="field"><span class="field-label">连接名称 <span class="text-err">*</span></span><input v-model="draft.name" class="input" placeholder="例如：团队主力模型" required maxlength="100" /></label>
          <div class="form-row"><label class="field"><span class="field-label">服务提供方 <span class="text-err">*</span></span><input v-model="draft.provider" class="input" list="connection-providers" required placeholder="openai" /><datalist id="connection-providers"><option value="openai" /><option value="anthropic" /><option value="deepseek" /><option value="ollama" /><option value="custom" /></datalist></label><label class="field"><span class="field-label">模型名称 <span class="text-err">*</span></span><input v-model="draft.model" class="input" placeholder="例如：gpt-4.1" required /></label></div>
          <label class="field"><span class="field-label">服务地址 <span class="text-err">*</span></span><input v-model="draft.baseUrl" class="input mono" type="url" placeholder="https://api.example.com/v1" required /><span class="field-help text-txt3">填写 HTTP(S) 基础地址，不含认证信息与查询参数。</span></label>
          <label class="field"><span class="field-label">凭据引用</span><input v-model="draft.credentialRef" class="input mono" placeholder="例如：env:OPENAI_API_KEY" autocomplete="off" /><span class="field-help text-txt3">只填写凭据标识，不要输入 API Key 或其他密钥。</span></label>
        </fieldset>
      </form>
      <template #footer><span v-if="dirty" class="text-warn unsaved">未保存的更改</span><AppButton variant="outline" :disabled="saving" @click="closeEditor">取消</AppButton><AppButton variant="primary" type="submit" form="connection-form" :loading="saving" icon="check">{{ draft?.id ? '保存连接' : '创建连接' }}</AppButton></template>
    </AppModal>
  </div>
</template>

<style scoped>
.connections-page { min-width: 0; }
.connection-intro { display: flex; align-items: center; gap: 18px; padding: 24px; }
.intro-icon { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 15px; flex-shrink: 0; }
.intro-copy { flex: 1; min-width: 0; }
.intro-copy h2 { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
.intro-copy p { font-size: 12px; line-height: 1.8; margin: 0; }
.intro-stat { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 72px; }
.intro-stat strong { font-size: 25px; font-weight: 600; }
.intro-stat span, .count { font-size: 12px; }
.connection-toolbar { flex-wrap: wrap; }
.connection-toolbar .search-input { flex: 1; max-width: 420px; min-width: 180px; }
.count { margin-left: auto; }
.connection-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: 16px; }
.connection-card { padding: 22px; min-width: 0; display: flex; flex-direction: column; transition: box-shadow .2s; }
.connection-card:hover { box-shadow: 0 5px 24px rgb(0 0 0 / .04); }
.card-heading { display: flex; align-items: center; gap: 12px; }
.provider-mark { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 11px; font-weight: 700; font-size: 13px; flex-shrink: 0; }
.card-title { min-width: 0; flex: 1; }
.card-title h2 { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; margin: 0; }
.provider { font-size: 11px; }
.config-badge { padding: 3px 7px; border: 1px solid; border-radius: 5px; font-size: 10px; white-space: nowrap; }
.connection-details { display: grid; gap: 14px; padding: 24px 0; margin: 0; flex: 1; }
.connection-details > div { display: grid; grid-template-columns: 65px minmax(0, 1fr); gap: 8px; font-size: 12px; }
.connection-details dd { display: flex; gap: 6px; align-items: baseline; margin: 0; overflow-wrap: anywhere; min-width: 0; }
.connection-details dd :deep(svg) { flex-shrink: 0; }
.endpoint, .mono { font-family: ui-monospace, monospace; font-size: 11px; }
.card-footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding-top: 14px; border-top-width: 1px; }
.card-actions { display: flex; gap: 4px; }
.test-result { display: flex; flex-direction: column; gap: 5px; padding: 12px; margin-bottom: 16px; border-radius: 8px; font-size: 11px; overflow-wrap: anywhere; }
.simulation-note { display: flex; gap: 8px; align-items: center; font-size: 11px; line-height: 1.8; }
.simulation-note :deep(svg) { flex-shrink: 0; }
.empty-action { display: flex; justify-content: center; padding: 0 20px 28px; }
.form-fields { display: grid; gap: 20px; border: 0; padding: 0; min-width: 0; }
.form-intro { font-size: 12px; margin: 0 0 22px; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.field { min-width: 0; }
.field-help { font-size: 11px; line-height: 1.7; }
.error-banner { padding: 12px 14px; border-radius: 8px; font-size: 12px; overflow-wrap: anywhere; margin-bottom: 16px; }
.unsaved { font-size: 11px; margin-right: auto; }
@media (max-width: 600px) { .connection-intro { padding: 18px; flex-wrap: wrap; gap: 12px; } .intro-copy { flex-basis: calc(100% - 64px); } .intro-stat { flex: 1; align-items: flex-start; padding-left: 4px; } .form-row { grid-template-columns: 1fr; } .connection-card { padding: 18px; } }
</style>
