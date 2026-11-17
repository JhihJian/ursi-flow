<script setup lang="ts">
defineProps<{
  title: string
  description: string
  capabilities: { title: string; description: string }[]
}>()
</script>

<template>
  <section>
    <p class="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-accent">ursi-flow / workspace</p>
    <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">{{ title }}</h1>
    <p class="mt-4 max-w-2xl text-base leading-7 text-muted">{{ description }}</p>
    <div class="mt-9 rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-9">
      <div class="flex flex-wrap items-center gap-3">
        <span class="rounded-full bg-teal-50 px-3 py-1 text-xs font-medium text-teal-800">功能准备中</span>
        <p class="text-sm text-muted">此功能尚未开放，以下为规划能力。</p>
      </div>
      <ul class="mt-8 grid gap-6 md:grid-cols-3">
        <li v-for="(capability, index) in capabilities" :key="capability.title" class="border-t border-line pt-5">
          <span class="text-xs font-semibold tabular-nums text-accent" aria-hidden="true">0{{ index + 1 }}</span>
          <h2 class="mt-3 text-base font-semibold">{{ capability.title }}</h2>
          <p class="mt-2 text-sm leading-6 text-muted">{{ capability.description }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>
