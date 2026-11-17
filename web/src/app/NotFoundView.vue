<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <section class="rounded-2xl border border-line bg-white px-6 py-16 text-center">
    <p class="text-sm font-semibold tracking-widest text-accent">404</p>
    <h1 class="mt-4 text-3xl font-semibold">页面未找到</h1>
    <p class="mt-4 text-muted">这个地址不存在，请检查链接或返回工作流。</p>
    <RouterLink to="/workflows" class="mt-8 inline-flex rounded-lg bg-ink px-5 py-3 text-sm font-medium text-white">返回工作流</RouterLink>
  </section>
</template>
