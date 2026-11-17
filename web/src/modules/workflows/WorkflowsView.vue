<script setup lang="ts">
import ModulePlaceholder from '@/shared/ui/ModulePlaceholder.vue'
</script>

<template>
  <ModulePlaceholder
    title="工作流"
    description="编排流程定义，查看节点依赖并发起运行。"
    :capabilities="[
      { title: '流程定义', description: '通过表单或定义文本维护节点、连线和执行配置。' },
      { title: '依赖查看', description: '以只读流程图查看节点类型、依赖关系与角色引用。' },
      { title: '发起运行', description: '从有效定义创建运行，追踪对应的执行记录。' },
    ]"
  />
</template>
