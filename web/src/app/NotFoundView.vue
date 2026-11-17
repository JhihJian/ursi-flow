<script setup lang="ts">
import { RouterLink } from 'vue-router'
import Icon from '@/shared/ui/Icon.vue'
</script>

<template>
  <section class="panel px-6 py-20 text-center">
    <Icon name="search" :size="32" class="mx-auto mb-6 text-accent-2" />
    <p class="text-xs font-medium tracking-widest text-txt3">404 / PAGE NOT FOUND</p>
    <h1 class="mt-4 text-2xl font-semibold">页面未找到</h1>
    <p class="mt-4 text-sm text-txt3">这个地址不存在，请检查链接或返回工作流。</p>
    <RouterLink to="/workflows" class="mt-8 inline-flex rounded-lg bg-accent px-5 py-3 text-sm font-medium text-white hover:bg-accent-hover">返回工作流</RouterLink>
  </section>
</template>
