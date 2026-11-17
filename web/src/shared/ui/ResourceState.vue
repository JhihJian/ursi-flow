<script setup lang="ts">
import { computed } from 'vue'
import AppButton from './AppButton.vue'
import Icon from './Icon.vue'
const props = defineProps<{ loading?: boolean; error?: unknown; empty?: boolean; title?: string; description?: string }>()
defineEmits<{ retry: [] }>()
const message = computed(() => props.error instanceof Error ? props.error.message : typeof props.error === 'string' ? props.error : '请检查网络连接后重试。')
</script>

<template>
  <section v-if="loading" class="panel p-6" role="status" aria-busy="true" aria-label="正在加载">
    <span class="sr-only">正在加载，请稍候。</span>
    <div aria-hidden="true" class="space-y-4">
      <div class="skeleton h-5 w-1/3" />
      <div v-for="row in 3" :key="row" class="flex items-center gap-4 border-t border-line pt-4">
        <div class="skeleton h-9 w-9 shrink-0" />
        <div class="min-w-0 flex-1 space-y-2"><div class="skeleton h-3 w-2/3" /><div class="skeleton h-3 w-1/3" /></div>
      </div>
    </div>
  </section>
  <section v-else-if="error" class="panel flex flex-col items-center px-6 py-12 text-center" role="alert">
    <span class="mb-4 rounded-xl bg-err/10 p-3 text-err"><Icon name="warning" :size="24" /></span>
    <h2 class="font-semibold text-txt">{{ title || '暂时无法加载' }}</h2>
    <p class="mt-2 max-w-md break-words text-sm leading-6 text-txt3">{{ description || message }}</p>
    <AppButton class="mt-5" icon="refresh" @click="$emit('retry')">重新加载</AppButton>
  </section>
  <section v-else-if="empty" class="panel flex flex-col items-center px-6 py-14 text-center" role="status">
    <span class="mb-4 rounded-xl border border-line bg-base p-3 text-txt3"><Icon name="folder" :size="25" /></span>
    <h2 class="font-semibold text-txt">{{ title || '暂无内容' }}</h2>
    <p class="mt-2 max-w-md text-sm leading-6 text-txt3">{{ description || '内容会在创建后显示在这里。' }}</p>
    <div v-if="$slots.default" class="mt-5"><slot /></div>
  </section>
</template>
