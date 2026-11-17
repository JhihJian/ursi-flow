<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/shared/ui/Icon.vue'
import AppButton from '@/shared/ui/AppButton.vue'
import AppModal from '@/shared/ui/AppModal.vue'
import AppTabs from '@/shared/ui/AppTabs.vue'
import PageHeader from '@/shared/ui/PageHeader.vue'
import ResourceState from '@/shared/ui/ResourceState.vue'
import { useRoleStudio } from './useRoleStudio'

const {
  roles, connections, rolesLoading, rolesError, reloadRoles, connectionsLoading, connectionsError, reloadConnections,
  search, filtered, draft, selectedId, detailLoading, detailError, actionError, tab, dirty, busy, saving, copying, deleting,
  createOpen, createName, createError, creating, loadDetail, selectRole, openCreate, closeCreate, create, changeConnection, save, discard, copy, remove,
} = useRoleStudio()
const tabs = computed(() => [
  { id: 'basic', label: '基本信息' }, { id: 'prompt', label: '系统提示词' },
  { id: 'skills', label: `Skills · ${draft.value?.skills.length ?? 0}` }, { id: 'mcp', label: `MCP · ${draft.value?.mcpServers.length ?? 0}` },
])
const icons = ['robot', 'terminal', 'search', 'doc', 'sparkles', 'brain']
const colors = ['#8b5cf6', '#3b82f6', '#059669', '#d97706', '#e11d48']
const executors = ['claude-code', 'codex', 'pi']
function avatarStyle(color: string) {
  const value = /^#[0-9a-f]{6}$/i.test(color) ? color : '#8b5cf6'
  return { color: value, backgroundColor: `${value}18` }
}
const executorOptions = computed(() => [...new Set([...executors, ...(draft.value?.executor ? [draft.value.executor] : [])])])
function updatedLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '尚未保存' : `更新于 ${date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
}
</script>

<template>
  <div class="page-stack roles-page">
    <PageHeader title="角色工作室" description="定义角色的思考方式，为流程装配专业能力。" icon="robot">
      <template #actions><span class="role-total text-txt3">{{ roles.length }} 个角色</span><AppButton icon="plus" :disabled="busy" @click="openCreate">创建角色</AppButton></template>
    </PageHeader>
    <div class="role-studio panel bg-surface border-line">
      <aside class="role-sidebar border-line" aria-label="角色列表">
        <div class="sidebar-heading"><span class="text-txt2">我的角色</span><AppButton variant="ghost" size="sm" icon="plus" aria-label="创建角色" :disabled="busy" @click="openCreate" /></div>
        <div class="sidebar-search search-input"><Icon name="search" :size="15" /><input v-model="search" aria-label="搜索角色" placeholder="搜索角色…" /></div>
        <ResourceState v-if="rolesLoading || rolesError" :loading="rolesLoading" :error="rolesError" @retry="reloadRoles" />
        <div v-else-if="!roles.length" class="sidebar-empty text-txt3"><Icon name="robot" :size="25" /><p>还没有角色</p><AppButton variant="outline" size="sm" @click="openCreate">创建第一个角色</AppButton></div>
        <div v-else-if="!filtered.length" class="sidebar-empty text-txt3"><p>没有匹配的角色</p><AppButton variant="ghost" size="sm" @click="search = ''">清空搜索</AppButton></div>
        <div v-else class="role-list">
          <button v-for="role in filtered" :key="role.id" type="button" class="role-item" :class="selectedId === role.id ? 'role-selected bg-accent/10' : 'hover:bg-elevated'" :aria-current="selectedId === role.id ? 'true' : undefined" :disabled="busy" @click="selectRole(role.id)">
            <span class="role-avatar" :style="avatarStyle(role.color)"><span v-if="role.icon && role.icon.length <= 2">{{ role.icon }}</span><Icon v-else :name="role.icon || 'robot'" :size="18" /></span><span class="role-item-text"><strong class="text-txt">{{ role.name }}</strong><span class="text-txt3">{{ role.model || '未选择模型' }}</span></span><span v-if="selectedId === role.id" class="selected-dot bg-accent" />
          </button>
        </div>
        <div class="sidebar-foot text-txt3 border-line"><Icon name="layers" :size="14" /><span>配置一次，在多个流程中复用</span></div>
      </aside>
      <section class="role-main" aria-label="角色编辑器" :aria-busy="detailLoading">
        <ResourceState v-if="detailLoading || detailError" :loading="detailLoading" :error="detailError" @retry="loadDetail()" />
        <div v-else-if="!draft" class="editor-empty"><div class="empty-avatar bg-accent/10 text-accent"><Icon name="robot" :size="34" /></div><h2 class="text-txt">让专业能力成为角色</h2><p class="text-txt3">为角色编写提示词、配置技能与工具，再将它加入你的工作流程。</p><AppButton icon="plus" :disabled="busy" @click="openCreate">创建角色</AppButton></div>
        <template v-else>
          <div class="editor-heading border-line">
            <span class="role-avatar large" :style="avatarStyle(draft.color)"><span v-if="draft.icon && draft.icon.length <= 2">{{ draft.icon }}</span><Icon v-else :name="draft.icon || 'robot'" :size="24" /></span>
            <div class="editor-title"><h2 class="text-txt">{{ draft.name || '未命名角色' }}</h2><p class="text-txt3">{{ updatedLabel(draft.updatedAt) }}<span v-if="dirty" class="dirty-marker text-warn">· 未保存</span></p></div>
            <div class="editor-actions"><AppButton variant="ghost" size="sm" icon="copy" :loading="copying" :disabled="busy || dirty" :title="dirty ? '保存更改后再复制' : '复制角色'" @click="copy">复制</AppButton><AppButton variant="ghost" size="sm" icon="trash" :loading="deleting" :disabled="busy" @click="remove">删除</AppButton></div>
          </div>
          <AppTabs v-model="tab" :tabs="tabs" />
          <p v-if="actionError" role="alert" class="error-banner text-err bg-err/10">{{ actionError }}</p>
          <fieldset class="editor-fields" :disabled="busy">
            <div v-if="tab === 'basic'" class="tab-content">
              <div class="section-heading"><h3 class="text-txt">角色身份</h3><p class="text-txt3">一个清晰的名称与职责，帮助团队找到合适的角色。</p></div>
              <div class="identity-row"><div class="field"><span class="field-label" id="role-icon-label">角色图标</span><div class="icon-picker" role="group" aria-labelledby="role-icon-label"><button v-for="icon in icons" :key="icon" type="button" class="icon-option border-line" :class="draft.icon === icon ? 'text-accent bg-accent/10 border-accent' : 'text-txt3 hover:bg-elevated'" :aria-label="`选择 ${icon} 图标`" :aria-pressed="draft.icon === icon" @click="draft.icon = icon"><Icon :name="icon" :size="17" /></button></div></div><div class="field"><span class="field-label" id="role-color-label">标识颜色</span><div class="color-picker" role="group" aria-labelledby="role-color-label"><button v-for="(color, index) in colors" :key="color" type="button" class="color-option role-avatar" :style="avatarStyle(color)" :aria-label="`选择${['紫色', '蓝色', '绿色', '琥珀色', '玫瑰色'][index]}`" :aria-pressed="draft.color === color" @click="draft.color = color"><Icon v-if="draft.color === color" name="check" :size="14" /></button></div></div></div>
              <label class="field"><span class="field-label">角色名称 <span class="text-err">*</span></span><input v-model="draft.name" class="input" placeholder="例如：需求分析师" maxlength="100" /></label>
              <label class="field"><span class="field-label">角色描述</span><textarea v-model="draft.description" class="textarea" rows="3" placeholder="描述角色的职责与适用场景…" /></label>
              <div class="section-heading runtime-heading border-line"><h3 class="text-txt">运行配置</h3><p class="text-txt3">选择执行器与模型连接，作为角色运行的默认配置。</p></div>
              <ResourceState v-if="connectionsLoading || connectionsError" :loading="connectionsLoading" :error="connectionsError" @retry="reloadConnections" />
              <div v-else-if="!connections.length" class="config-hint text-warn bg-warn/10">暂无模型连接。请先前往 <RouterLink to="/connections" class="underline">模型连接</RouterLink> 创建连接，再返回配置角色。<AppButton variant="ghost" size="sm" @click="reloadConnections">刷新连接</AppButton></div>
              <div class="form-row"><label class="field"><span class="field-label">执行器 <span class="text-err">*</span></span><select v-model="draft.executor" class="select"><option v-for="executor in executorOptions" :key="executor" :value="executor">{{ executor }}</option></select></label><label class="field"><span class="field-label">模型连接 <span class="text-err">*</span></span><select v-model="draft.connectionId" class="select" :disabled="connectionsLoading || !!connectionsError" @change="changeConnection"><option value="" disabled>选择模型连接</option><option v-if="draft.connectionId && !connections.some(item => item.id === draft?.connectionId)" :value="draft.connectionId">连接不可用，请重新选择</option><option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.name }} · {{ connection.provider }}</option></select></label></div>
              <label class="field"><span class="field-label">模型名称 <span class="text-err">*</span></span><input v-model="draft.model" class="input mono" placeholder="选择连接后填入默认模型，也可自行调整" /></label>
            </div>
            <div v-else-if="tab === 'prompt'" class="tab-content prompt-content">
              <div class="section-heading"><h3 class="text-txt">系统提示词</h3><p class="text-txt3">定义角色的目标、工作方法与输出要求。支持 Markdown 格式。</p></div>
              <label class="prompt-label"><span class="sr-only">系统提示词</span><textarea v-model="draft.systemPrompt" class="textarea prompt-editor mono" spellcheck="false" placeholder="# 角色定位&#10;你是一位…&#10;&#10;# 工作方式&#10;1. 理解输入与目标&#10;2. 分析问题并给出可执行的结果&#10;&#10;# 输出要求&#10;清晰、准确、有依据。" /></label>
              <div class="prompt-foot text-txt3"><span>Markdown</span><span>{{ draft.systemPrompt.length.toLocaleString() }} 字符</span></div>
            </div>
            <div v-else-if="tab === 'skills'" class="tab-content">
              <div class="section-heading with-action"><div><h3 class="text-txt">技能库</h3><p class="text-txt3">将可复用的方法与操作说明，沉淀为角色的专业技能。</p></div><AppButton variant="outline" size="sm" icon="plus" @click="draft.skills.push({ name: '', content: '' })">添加 Skill</AppButton></div>
              <div v-if="!draft.skills.length" class="capability-empty border-line"><Icon name="skills" :size="30" class="text-txt3" /><h4 class="text-txt2">为角色添加一项专长</h4><p class="text-txt3">例如代码审查规范、调研方法或报告模板。</p><AppButton variant="outline" size="sm" icon="plus" @click="draft.skills.push({ name: '', content: '' })">添加第一个 Skill</AppButton></div>
              <article v-for="(skill, index) in draft.skills" :key="index" class="capability-card border-line">
                <div class="capability-heading bg-elevated border-line"><Icon name="skills" :size="16" class="text-accent" /><span class="text-txt2">Skill {{ String(index + 1).padStart(2, '0') }}</span><AppButton variant="ghost" size="sm" icon="trash" :aria-label="`移除 Skill ${index + 1}`" @click="draft.skills.splice(index, 1)">移除</AppButton></div>
                <div class="capability-body"><label class="field"><span class="field-label">技能名称</span><input v-model="skill.name" class="input" placeholder="例如：code-review" /></label><label class="field"><span class="field-label">技能内容</span><textarea v-model="skill.content" class="textarea skill-editor mono" rows="8" placeholder="使用 Markdown 编写技能说明、操作步骤与注意事项…" spellcheck="false" /></label></div>
              </article>
            </div>
            <div v-else-if="tab === 'mcp'" class="tab-content">
              <div class="section-heading with-action"><div><h3 class="text-txt">MCP 工具服务</h3><p class="text-txt3">连接外部工具与数据源，拓展角色的执行能力。</p></div><AppButton variant="outline" size="sm" icon="plus" @click="draft.mcpServers.push({ name: '', transport: 'http', url: '', credentialRef: '' })">添加 MCP</AppButton></div>
              <div class="config-hint bg-elevated text-txt3"><Icon name="lock" :size="15" />认证信息只填写凭据引用，请勿在命令或地址中填写密钥。</div>
              <div v-if="!draft.mcpServers.length" class="capability-empty border-line"><Icon name="connector" :size="30" class="text-txt3" /><h4 class="text-txt2">连接角色所需的工具</h4><p class="text-txt3">支持 HTTP 服务与 stdio 本地命令。</p><AppButton variant="outline" size="sm" icon="plus" @click="draft.mcpServers.push({ name: '', transport: 'http', url: '', credentialRef: '' })">添加第一个 MCP</AppButton></div>
              <article v-for="(server, index) in draft.mcpServers" :key="index" class="capability-card border-line">
                <div class="capability-heading bg-elevated border-line"><Icon name="connector" :size="16" class="text-accent" /><span class="text-txt2">MCP {{ String(index + 1).padStart(2, '0') }}</span><AppButton variant="ghost" size="sm" icon="trash" :aria-label="`移除 MCP ${index + 1}`" @click="draft.mcpServers.splice(index, 1)">移除</AppButton></div>
                <div class="capability-body"><div class="form-row"><label class="field"><span class="field-label">服务名称</span><input v-model="server.name" class="input" placeholder="例如：knowledge-base" /></label><label class="field"><span class="field-label">传输方式</span><select v-model="server.transport" class="select"><option value="http">HTTP · 远程服务</option><option value="stdio">stdio · 本地命令</option></select></label></div><label v-if="server.transport === 'http'" class="field"><span class="field-label">服务 URL</span><input v-model="server.url" class="input mono" type="url" placeholder="https://mcp.example.com/mcp" /></label><label v-else class="field"><span class="field-label">启动命令</span><input v-model="server.command" class="input mono" placeholder="例如：npx -y @example/mcp-server" /></label><label class="field"><span class="field-label">凭据引用（可选）</span><input v-model="server.credentialRef" class="input mono" placeholder="例如：env:MCP_TOKEN" autocomplete="off" /></label></div>
              </article>
            </div>
          </fieldset>
          <div class="editor-footer bg-surface border-line"><span class="save-hint" :class="dirty ? 'text-warn' : 'text-txt3'"><span class="status-dot" />{{ dirty ? '有未保存的更改' : '所有更改已保存' }}</span><div class="save-actions"><AppButton v-if="dirty" variant="ghost" size="sm" :disabled="busy" @click="discard">放弃更改</AppButton><AppButton icon="check" size="sm" :loading="saving" :disabled="busy || !dirty || connectionsLoading || !!connectionsError" @click="save">保存角色</AppButton></div></div>
        </template>
      </section>
    </div>
    <AppModal :open="createOpen" title="创建角色" :width="460" @close="closeCreate">
      <form id="role-create-form" @submit.prevent="create"><p class="create-description text-txt3">从一个名称开始，随后配置提示词、技能和工具。{{ connections.length ? `默认使用「${connections[0]?.name}」连接，创建后可修改。` : '请先创建模型连接。' }}</p><ResourceState v-if="connectionsLoading || connectionsError" :loading="connectionsLoading" :error="connectionsError" @retry="reloadConnections" /><p v-else-if="!connections.length" class="create-description text-warn"><RouterLink to="/connections" class="underline">前往创建模型连接</RouterLink></p><p v-if="createError" role="alert" class="error-banner bg-err/10 text-err">{{ createError }}</p><label class="field"><span class="field-label">角色名称</span><input v-model="createName" class="input" required maxlength="100" placeholder="例如：产品需求分析师" :disabled="creating" /></label></form>
      <template #footer><AppButton variant="outline" :disabled="creating" @click="closeCreate">取消</AppButton><AppButton type="submit" form="role-create-form" icon="plus" :loading="creating" :disabled="!createName.trim() || connectionsLoading || !!connectionsError || !connections.length">创建角色</AppButton></template>
    </AppModal>
  </div>
</template>

<style scoped>
.roles-page { min-width: 0; }
.role-total { font-size: 12px; }
.role-studio { display: grid; grid-template-columns: 252px minmax(0, 1fr); min-height: 680px; overflow: hidden; padding: 0; }
.role-sidebar { display: flex; flex-direction: column; border-right-width: 1px; min-width: 0; padding: 12px; }
.sidebar-heading { display: flex; justify-content: space-between; align-items: center; padding: 3px 5px 12px; font-size: 12px; font-weight: 600; }
.sidebar-search { margin-bottom: 14px; }
.role-list { display: flex; flex-direction: column; gap: 5px; }
.role-item { display: flex; align-items: center; gap: 11px; width: 100%; min-width: 0; padding: 12px 10px; border-radius: 9px; text-align: left; transition: background .15s; }
.role-item:disabled { opacity: .65; }
.role-avatar { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 35px; height: 35px; border-radius: 10px; background: #ede9fe; color: #8b5cf6; }
.role-item-text { display: flex; flex-direction: column; min-width: 0; gap: 4px; flex: 1; }
.role-item-text strong { font-size: 12px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.role-item-text > span { font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.selected-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
.sidebar-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 34px 8px; font-size: 12px; }
.sidebar-foot { display: flex; align-items: center; gap: 7px; margin-top: auto; padding: 18px 4px 4px; font-size: 10px; }
.role-main { min-width: 0; display: flex; flex-direction: column; }
.editor-heading { display: flex; align-items: center; gap: 13px; padding: 23px 28px; border-bottom-width: 1px; flex-wrap: wrap; }
.large { width: 47px; height: 47px; border-radius: 13px; }
.editor-title { min-width: 0; flex: 1; }
.editor-title h2 { margin: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
.editor-title p { font-size: 10px; margin: 6px 0 0; line-height: 1.6; }
.dirty-marker { margin-left: 8px; }
.editor-actions { display: flex; gap: 3px; }
.editor-fields { margin: 0; padding: 0; border: 0; min-width: 0; flex: 1; }
.tab-content { display: flex; flex-direction: column; gap: 22px; padding: 28px; }
.section-heading h3 { font-size: 14px; font-weight: 600; margin: 0 0 6px; }
.section-heading p { font-size: 12px; margin: 0; line-height: 1.8; }
.with-action { display: flex; gap: 14px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.with-action > div { flex: 1; min-width: 170px; }
.with-action :deep(button) { flex-shrink: 0; }
.identity-row { display: flex; flex-wrap: wrap; gap: 20px 36px; }
.icon-picker, .color-picker { display: flex; gap: 7px; flex-wrap: wrap; }
.icon-option { width: 34px; height: 34px; display: grid; place-items: center; border-width: 1px; border-radius: 7px; }
.color-option { width: 25px; height: 25px; border-radius: 50%; margin-top: 4px; }
.color-option[aria-pressed="true"] { outline: 2px solid currentColor; outline-offset: 2px; }
.runtime-heading { border-top-width: 1px; padding-top: 24px; margin-top: 2px; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.field { min-width: 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.prompt-label { display: flex; flex: 1; }
.prompt-editor { width: 100%; min-height: 390px; font-size: 12px; line-height: 1.9; padding: 18px; tab-size: 2; }
.prompt-foot { display: flex; justify-content: space-between; font-size: 10px; margin-top: -12px; }
.capability-card { border-width: 1px; border-radius: 10px; overflow: hidden; }
.capability-heading { display: flex; align-items: center; gap: 8px; border-bottom-width: 1px; padding: 8px 15px; font-size: 11px; }
.capability-heading > span { flex: 1; }
.capability-body { display: flex; flex-direction: column; gap: 18px; padding: 20px; }
.skill-editor { font-size: 12px; line-height: 1.8; }
.capability-empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 40px 18px; border: 1px dashed; border-radius: 10px; }
.capability-empty h4 { font-size: 13px; margin: 16px 0 5px; }
.capability-empty p { font-size: 12px; line-height: 1.8; margin: 0 0 20px; }
.config-hint { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px 14px; border-radius: 7px; font-size: 11px; line-height: 1.8; }
.editor-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; border-top-width: 1px; padding: 16px 28px; margin-top: auto; }
.save-hint { display: flex; align-items: center; gap: 7px; font-size: 11px; }
.status-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.save-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
.error-banner { margin: 16px 20px 0; padding: 12px 14px; font-size: 12px; border-radius: 8px; overflow-wrap: anywhere; }
.editor-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 70px 30px; text-align: center; }
.empty-avatar { display: grid; place-items: center; width: 76px; height: 76px; border-radius: 23px; margin-bottom: 22px; }
.editor-empty h2 { font-size: 20px; font-weight: 600; margin: 0 0 10px; }
.editor-empty p { font-size: 12px; max-width: 320px; line-height: 1.9; margin: 0 0 24px; }
.create-description { font-size: 12px; line-height: 1.8; margin: 0 0 22px; }
#role-create-form .error-banner { margin: 0 0 18px; }
@media (max-width: 1100px) { .role-studio { grid-template-columns: 215px minmax(0, 1fr); } .tab-content { padding: 22px; } .editor-heading { padding: 20px; } }
@media (max-width: 760px) { .role-studio { grid-template-columns: minmax(0, 1fr); } .role-sidebar { border-right: 0; border-bottom-width: 1px; max-height: 280px; overflow-y: auto; } .role-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); } .sidebar-foot { display: none; } .role-main { min-height: 520px; } .editor-actions { margin-left: auto; } .tab-content { padding: 20px 16px; } .editor-heading { padding: 18px 16px; } .editor-footer { padding: 16px; } .form-row { grid-template-columns: 1fr; } .capability-body { padding: 16px; } .role-total { display: none; } }
@media (max-width: 390px) { .editor-actions { width: 100%; justify-content: flex-end; } .role-list { grid-template-columns: 1fr; } }
</style>
