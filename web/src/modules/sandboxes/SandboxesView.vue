<script setup lang="ts">
import ModulePlaceholder from '@/shared/ui/ModulePlaceholder.vue'
</script>

<template>
  <ModulePlaceholder
    title="沙箱管理"
    description="查看执行资源、运行关联与获准的访问入口。"
    :capabilities="[
      { title: '资源关联', description: '查看运行对应的沙箱标识、准备进度与资源状态。' },
      { title: '文件与连接', description: '访问已就绪资源的获准文件、终端或预览入口。' },
      { title: '释放结果', description: '查看资源清理结果，区分释放失败与待确认状态。' },
    ]"
  />
</template>
