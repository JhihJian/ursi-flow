<script setup lang="ts">
import type { Run } from '@/shared/api/types'
defineProps<{ snapshot: Run['snapshot'] }>()
const pretty = (value: unknown) => JSON.stringify(value, null, 2)
</script>
<template>
  <div class="space-y-5">
    <p class="text-xs leading-6 text-txt3">以下是创建运行时保存的配置。工作流与角色之后的修改不会改变这份快照。</p>
    <section><h3 class="mb-2 text-sm font-medium">{{ snapshot.workflow.name }}</h3><p class="text-sm text-txt3">{{ snapshot.workflow.description || '暂无描述' }}</p><details class="snapshot-detail mt-3"><summary>流程节点与连线</summary><pre>{{ pretty({ nodes: snapshot.workflow.nodes, edges: snapshot.workflow.edges }) }}</pre></details></section>
    <section><h3 class="mb-3 text-sm font-medium">角色配置 <span class="text-txt3">{{ snapshot.roles.length }}</span></h3>
      <p v-if="!snapshot.roles.length" class="text-xs text-txt3">该流程没有引用角色。</p>
      <details v-for="role in snapshot.roles" :key="role.id" class="snapshot-detail mb-2">
        <summary>{{ role.name }} <span class="ml-2 font-normal text-txt3">{{ role.model }}</span></summary>
        <div class="space-y-4 p-4">
          <dl class="grid grid-cols-[70px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"><dt class="text-txt3">角色标识</dt><dd>{{ role.id }}</dd><dt class="text-txt3">执行器</dt><dd>{{ role.executor }}</dd><dt class="text-txt3">模型连接</dt><dd>{{ snapshot.connections.find(connection => connection.id === role.connectionId)?.name || role.connectionId }}</dd></dl>
          <div><h4 class="text-xs font-medium">系统提示词</h4><pre class="!px-0 !pb-0">{{ role.systemPrompt || '未配置' }}</pre></div>
          <div><h4 class="mb-2 text-xs font-medium">技能 · {{ role.skills.length }}</h4><details v-for="(skill, index) in role.skills" :key="index" class="snapshot-detail mb-2"><summary>{{ skill.name }}</summary><pre>{{ skill.content || '无内容' }}</pre></details><p v-if="!role.skills.length" class="text-xs text-txt3">未配置技能</p></div>
          <div><h4 class="mb-2 text-xs font-medium">MCP 服务 · {{ role.mcpServers.length }}</h4><pre v-if="role.mcpServers.length" class="!p-0">{{ pretty(role.mcpServers) }}</pre><p v-else class="text-xs text-txt3">未配置 MCP 服务</p></div>
        </div>
      </details>
    </section>
    <details v-if="snapshot.connections.length" class="snapshot-detail"><summary>模型连接快照 · {{ snapshot.connections.length }}</summary><pre>{{ pretty(snapshot.connections) }}</pre></details>
  </div>
</template>
<style scoped>
.snapshot-detail { border: 1px solid rgb(var(--c-line)); border-radius: 8px; overflow: hidden; }
summary { cursor: pointer; padding: 11px 14px; font-size: 12px; font-weight: 500; background: rgb(var(--c-elevated) / .4); }
pre { padding: 14px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.8; color: rgb(var(--c-txt2)); }
</style>
