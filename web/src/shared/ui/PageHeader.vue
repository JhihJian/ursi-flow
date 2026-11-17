<script setup lang="ts">
import Icon from './Icon.vue'
defineProps<{ title: string; description?: string; icon?: string }>()
</script>

<template>
  <header class="flex flex-wrap items-start justify-between gap-5">
    <div class="flex min-w-0 items-start gap-3.5">
      <span v-if="icon" class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-accent"><Icon :name="icon" :size="22" /></span>
      <div class="min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight text-txt">{{ title }}</h1>
        <p v-if="description" class="mt-1.5 max-w-2xl text-sm leading-6 text-txt3">{{ description }}</p>
      </div>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2"><slot name="actions" /></div>
  </header>
</template>
