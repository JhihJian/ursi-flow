<script setup lang="ts">
import { RouterLink } from 'vue-router'
import Icon from './Icon.vue'
defineProps<{
  groups: { title: string; items: { path: string; title: string; icon: string }[] }[]
  dark: boolean
  demo: boolean
}>()
defineEmits<{ navigate: []; theme: []; settings: [] }>()
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <RouterLink to="/workflows" class="flex items-center gap-3 px-5 py-6" aria-label="ursi-flow 首页" @click="$emit('navigate')">
      <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white"><Icon name="workflow" :size="23" /></span>
      <span><span class="block text-[17px] font-semibold tracking-tight text-txt">ursi-flow</span><span class="mt-0.5 block text-[11px] tracking-wide text-txt3">流程与 Agent 协作</span></span>
    </RouterLink>
    <nav aria-label="主导航" class="scroll-area min-h-0 flex-1 space-y-7 overflow-y-auto px-3 py-4">
      <section v-for="group in groups" :key="group.title">
        <h2 class="mb-2 px-3 text-[11px] font-medium tracking-wider text-txt3">{{ group.title }}</h2>
        <div class="space-y-1">
          <RouterLink v-for="item in group.items" :key="item.path" :to="item.path" class="sidebar-link" active-class="nav-active" @click="$emit('navigate')">
            <Icon :name="item.icon" :size="18" /><span>{{ item.title }}</span>
          </RouterLink>
        </div>
      </section>
    </nav>
    <div class="mx-3 mb-3 border-t border-line pt-3">
      <button type="button" class="sidebar-link w-full" :aria-label="dark ? '切换到亮色主题' : '切换到暗色主题'" @click="$emit('theme')">
        <Icon :name="dark ? 'sun' : 'moon'" /><span>{{ dark ? '亮色外观' : '暗色外观' }}</span>
      </button>
      <button v-if="demo" type="button" class="sidebar-link w-full" @click="$emit('settings')"><Icon name="flask" /><span>演示模式</span><Icon name="settings" :size="14" class="ml-auto text-txt3" /></button>
      <div v-else class="flex items-center gap-3 px-3 py-2.5 text-sm text-txt3"><Icon name="server" /><span>真实服务</span></div>
      <div class="mt-3 flex items-center gap-3 rounded-lg border border-line bg-surface p-3">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-dim text-xs font-semibold text-accent-2" aria-hidden="true">UF</span>
        <div class="min-w-0"><p class="truncate text-xs font-medium text-txt">默认工作区</p><p class="mt-0.5 text-[11px] text-txt3">{{ demo ? '本地演示空间' : '协作工作空间' }}</p></div>
      </div>
    </div>
  </div>
</template>
