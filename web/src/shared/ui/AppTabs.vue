<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  tabs: {
    id: string
    label: string
    /** Visually muted + line-through; click does not change model (optional disabledClick). */
    ghosted?: boolean
    disabled?: boolean
  }[]
  modelValue: string
}>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'disabled-click', id: string): void
}>()

const track = ref<HTMLElement | null>(null)
const indicatorStyle = ref<Record<string, string>>({
  opacity: '0',
  transform: 'translateX(0)',
  width: '0px',
})

function onTabClick(t: { id: string; ghosted?: boolean; disabled?: boolean }) {
  if (t.ghosted || t.disabled) {
    emit('disabled-click', t.id)
    return
  }
  emit('update:modelValue', t.id)
}

function onKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const enabled = props.tabs.filter((tab) => !tab.disabled && !tab.ghosted)
  if (!enabled.length) return
  event.preventDefault()
  const current = enabled.findIndex((tab) => tab.id === props.modelValue)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length
  const tab = enabled[index]
  if (!tab) return
  emit('update:modelValue', tab.id)
  void nextTick(() => track.value?.querySelector<HTMLElement>('[data-tab-active="true"]')?.focus())
}

function updateIndicator() {
  const root = track.value
  if (!root) return
  const active = root.querySelector<HTMLElement>('[data-tab-active="true"]')
  if (!active) {
    indicatorStyle.value = { opacity: '0', transform: 'translateX(0)', width: '0px' }
    return
  }
  const left = active.offsetLeft + 8
  const width = Math.max(0, active.offsetWidth - 16)
  indicatorStyle.value = {
    opacity: '1',
    transform: `translateX(${left}px)`,
    width: `${width}px`,
  }
}

watch(
  () => [props.modelValue, props.tabs] as const,
  () => {
    void nextTick(updateIndicator)
  },
  { deep: true },
)

onMounted(() => {
  void nextTick(updateIndicator)
  window.addEventListener('resize', updateIndicator)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateIndicator)
})
</script>

<template>
  <div class="scroll-area -mx-1 overflow-x-auto">
    <div ref="track" role="tablist" class="relative flex min-w-max items-center gap-1 border-b border-line px-1" @keydown="onKeydown">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        role="tab"
        :aria-selected="modelValue === t.id"
        :tabindex="modelValue === t.id ? 0 : -1"
        class="relative -mb-px shrink-0 px-3.5 py-2.5 text-sm font-medium transition"
        :class="[
          t.ghosted || t.disabled
            ? 'cursor-not-allowed text-txt3/40 line-through'
            : modelValue === t.id
              ? 'text-txt'
              : 'text-txt3 hover:text-txt2',
        ]"
        :data-tab-active="modelValue === t.id && !t.ghosted && !t.disabled ? 'true' : undefined"
        :aria-disabled="t.ghosted || t.disabled ? 'true' : undefined"
        @click="onTabClick(t)"
      >
        {{ t.label }}
      </button>
      <span
        class="app-tabs-indicator pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-accent"
        data-testid="app-tabs-indicator"
        :style="indicatorStyle"
        aria-hidden="true"
      />
    </div>
  </div>
</template>

<style scoped>
.app-tabs-indicator {
  transition:
    transform var(--dur-ui) var(--ease-out-expo),
    width var(--dur-ui) var(--ease-out-expo),
    opacity var(--dur-ui) ease;
}
</style>
