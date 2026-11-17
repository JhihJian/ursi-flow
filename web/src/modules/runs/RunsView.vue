<script setup lang="ts">
import ModulePlaceholder from '@/shared/ui/ModulePlaceholder.vue'
</script>

<template>
  <ModulePlaceholder
    title="运行记录"
    description="追踪运行进度、查看执行事件并处理人工审批。"
    :capabilities="[
      { title: '进度与快照', description: '查看运行状态、节点执行轮次与创建时冻结的配置。' },
      { title: '事件与产物', description: '追踪工具轨迹、日志及产物，按游标接续运行事件。' },
      { title: '人工审批', description: '对等待审批的节点放行或打回合法的上游环节。' },
    ]"
  />
</template>
