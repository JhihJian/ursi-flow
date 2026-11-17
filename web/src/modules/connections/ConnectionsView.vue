<script setup lang="ts">
import ModulePlaceholder from '@/shared/ui/ModulePlaceholder.vue'
</script>

<template>
  <ModulePlaceholder
    title="模型连接"
    description="配置模型服务端点、凭据引用与能力选择。"
    :capabilities="[
      { title: '服务配置', description: '维护连接名称、服务类型和模型服务端点。' },
      { title: '凭据引用', description: '通过受控凭据引用配置认证，保持敏感信息隔离。' },
      { title: '能力与引用', description: '查看执行能力匹配结果及角色引用导致的删除约束。' },
    ]"
  />
</template>
