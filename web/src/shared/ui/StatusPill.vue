<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ status: string }>()
const states: Record<string, { label: string; tone: string }> = {
  queued: { label: '排队中', tone: 'neutral' }, pending: { label: '待执行', tone: 'neutral' },
  running: { label: '运行中', tone: 'info' }, waiting: { label: '待确认', tone: 'warn' },
  waiting_approval: { label: '待审批', tone: 'warn' }, succeeded: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'err' }, cancelled: { label: '已取消', tone: 'neutral' },
  released: { label: '已释放', tone: 'neutral' }, active: { label: '可用', tone: 'ok' },
  draft: { label: '草稿', tone: 'neutral' }, ready: { label: '就绪', tone: 'ok' },
  disabled: { label: '已停用', tone: 'neutral' }, connected: { label: '已连接', tone: 'ok' },
}
const state = computed(() => states[props.status] ?? { label: props.status, tone: 'neutral' })
</script>

<template>
  <span class="status-pill" :class="`status-${state.tone}`"><span class="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />{{ state.label }}</span>
</template>

<style scoped>
.status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 6px; font-size: 12px; font-weight: 500; line-height: 18px; white-space: nowrap; color: rgb(var(--c-txt3)); background: rgb(var(--c-elevated)); }
.status-ok { color: rgb(var(--c-ok)); background: rgb(var(--c-ok) / .1); }
.status-info { color: rgb(var(--c-info)); background: rgb(var(--c-info) / .1); }
.status-warn { color: rgb(var(--c-warn)); background: rgb(var(--c-warn) / .1); }
.status-err { color: rgb(var(--c-err)); background: rgb(var(--c-err) / .1); }
</style>
