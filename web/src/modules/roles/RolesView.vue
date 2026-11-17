<script setup lang="ts">
import ModulePlaceholder from '@/shared/ui/ModulePlaceholder.vue'
</script>

<template>
  <ModulePlaceholder
    title="角色管理"
    description="管理角色提示词、技能文件、MCP 与模型选择。"
    :capabilities="[
      { title: '角色配置', description: '维护提示词、执行器和模型选择，管理角色副本。' },
      { title: 'Skills 与 MCP', description: '管理完整技能文件包与结构化 MCP 连接配置。' },
      { title: '引用与快照', description: '查看引用冲突，区分当前角色配置与运行冻结版本。' },
    ]"
  />
</template>
