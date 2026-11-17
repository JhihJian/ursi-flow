<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import type { Role, Workflow } from '@/shared/api/types'
import Icon from '@/shared/ui/Icon.vue'
import { nodeTypeLabel } from './definition'
const props = defineProps<{ workflow: Workflow; roles?: Role[] }>()
const selectedId = ref('')
const markerId = `flow-arrow-${useId().replace(/:/g, '')}`
const selected = computed(() => props.workflow.nodes.find(node => node.id === selectedId.value))
const layout = computed(() => {
  const remaining = new Set(props.workflow.nodes.map(node => node.id))
  const positions = new Map<string, { x: number; y: number }>()
  let column = 0
  let maxRows = 1
  while (remaining.size) {
    let ready = [...remaining].filter(id => !props.workflow.edges.some(edge => edge.target === id && remaining.has(edge.source)))
    if (!ready.length) ready = [...remaining]
    maxRows = Math.max(maxRows, ready.length)
    ready.forEach((id, row) => { positions.set(id, { x: column * 240 + 24, y: row * 106 + 24 }); remaining.delete(id) })
    column++
  }
  return { positions, width: Math.max(column * 240 + 8, 280), height: maxRows * 106 + 20 }
})
const lines = computed(() => props.workflow.edges.flatMap(edge => {
  const from = layout.value.positions.get(edge.source)
  const to = layout.value.positions.get(edge.target)
  if (!from || !to) return []
  const x = from.x + 190
  const y = from.y + 35
  return [{ key: `${edge.source}-${edge.target}`, path: `M ${x} ${y} C ${x + 28} ${y}, ${to.x - 28} ${to.y + 35}, ${to.x - 4} ${to.y + 35}` }]
}))
</script>

<template>
  <div class="diagram-scroll" aria-label="只读工作流依赖图">
    <div class="diagram" :style="{ width: `${layout.width}px`, height: `${layout.height}px` }">
      <svg :width="layout.width" :height="layout.height" aria-hidden="true" class="connections">
        <defs><marker :id="markerId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        <path v-for="line in lines" :key="line.key" :d="line.path" fill="none" stroke="currentColor" stroke-width="1.5" :marker-end="`url(#${markerId})`" />
      </svg>
      <button v-for="node in workflow.nodes" :key="node.id" type="button" class="flow-node" :class="{ selected: selectedId === node.id }" :style="{ left: `${layout.positions.get(node.id)?.x}px`, top: `${layout.positions.get(node.id)?.y}px` }" :aria-pressed="selectedId === node.id" @click="selectedId = selectedId === node.id ? '' : node.id">
        <Icon :name="node.type === 'agent' ? 'robot' : node.type === 'approval' ? 'gate' : 'terminal'" :size="18" />
        <span><strong>{{ node.name }}</strong><small>{{ nodeTypeLabel[node.type] }}</small></span>
      </button>
    </div>
  </div>
  <div v-if="selected" class="node-info">
    <div class="flex items-center gap-2"><strong>{{ selected.name }}</strong><code class="text-xs text-txt3">{{ selected.id }}</code></div>
    <p class="mt-1 text-sm text-txt3">类型：{{ nodeTypeLabel[selected.type] }}<template v-if="selected.roleId"> · 角色：{{ roles?.find(role => role.id === selected?.roleId)?.name || selected.roleId }}</template></p>
    <pre v-if="selected.script" class="mt-3 whitespace-pre-wrap text-xs">{{ selected.script }}</pre>
    <p class="mt-2 text-xs text-txt3">上游：{{ workflow.edges.filter(edge => edge.target === selected?.id).map(edge => workflow.nodes.find(node => node.id === edge.source)?.name || edge.source).join('、') || '起始节点' }}</p>
  </div>
  <p v-else class="px-4 py-3 text-xs text-txt3">点击节点查看类型、角色与依赖配置。流程图为只读视图。</p>
</template>

<style scoped>
.diagram-scroll { overflow: auto; background: radial-gradient(rgb(var(--c-line)) 1px, transparent 1px); background-size: 16px 16px; border-radius: 8px; }
.diagram { position: relative; }
.connections { position: absolute; inset: 0; color: rgb(var(--c-line-strong)); pointer-events: none; }
.flow-node { position: absolute; width: 190px; height: 70px; display: flex; align-items: center; gap: 10px; padding: 12px; text-align: left; background: rgb(var(--c-surface)); color: rgb(var(--c-txt2)); border: 1px solid rgb(var(--c-line-strong)); border-radius: 9px; }
.flow-node.selected, .flow-node:hover { border-color: rgb(var(--c-accent)); }
.flow-node.selected { box-shadow: 0 0 0 2px rgb(var(--c-accent) / .1); }
.flow-node span { min-width: 0; }
.flow-node strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
.flow-node small { display: block; margin-top: 3px; color: rgb(var(--c-txt3)); font-size: 10px; }
.node-info { border-top: 1px solid rgb(var(--c-line)); padding: 16px; }
</style>
