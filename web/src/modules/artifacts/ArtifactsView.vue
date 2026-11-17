<script setup lang="ts">
import ModulePlaceholder from '@/shared/ui/ModulePlaceholder.vue'
</script>

<template>
  <ModulePlaceholder
    title="产物管理"
    description="查阅运行交付物，追溯节点与执行轮次。"
    :capabilities="[
      { title: '归属检索', description: '按运行、节点、持有代数与执行轮次查找产物。' },
      { title: '内容查看', description: '通过稳定产物标识查看内容、类型和校验信息。' },
      { title: '历史追溯', description: '区分当前有效输出与重试、返工保留的历史产物。' },
    ]"
  />
</template>
