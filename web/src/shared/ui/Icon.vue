<script setup lang="ts">
import { computed } from 'vue'
import { resolveIcon, type IconName } from '@/shared/icons/catalog'

defineOptions({ name: 'AppIcon' })
const props = withDefaults(defineProps<{
  name: IconName | (string & {})
  size?: number | string
  busy?: boolean
  disabled?: boolean
}>(), { size: 18, busy: undefined, disabled: false })
const definition = computed(() => resolveIcon(props.name))
const spinning = computed(() => !props.disabled && (props.busy ?? props.name === 'spinner'))
// SVG markup only comes from Grasp's checked-in, trusted local icon catalog.
</script>

<template>
  <svg
    class="app-icon"
    :class="{ 'icon-spinner': spinning }"
    aria-hidden="true"
    focusable="false"
    :data-icon="name"
    :width="size"
    :height="size"
    :viewBox="definition.viewBox"
    :fill="definition.filled ? 'currentColor' : 'none'"
    :stroke="definition.strokeWidth ? 'currentColor' : 'none'"
    :stroke-width="definition.strokeWidth || undefined"
    stroke-linecap="round"
    stroke-linejoin="round"
    v-html="definition.body"
  />
</template>

<style scoped>
.app-icon { display: inline-block; flex-shrink: 0; vertical-align: middle; }
.icon-spinner { animation: icon-spin 0.85s linear infinite; }
@keyframes icon-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .icon-spinner { animation: none; } }
</style>
