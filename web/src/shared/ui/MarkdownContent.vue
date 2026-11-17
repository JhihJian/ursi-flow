<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
const props = defineProps<{ content: string }>()
const html = computed(() => DOMPurify.sanitize(marked.parse(props.content, { async: false }), { FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'img'], FORBID_ATTR: ['style'] }))
</script>

<template><div class="markdown-content" v-html="html" /></template>

<style scoped>
.markdown-content { color: rgb(var(--c-txt2)); font-size: 14px; line-height: 1.9; overflow-wrap: anywhere; }
.markdown-content :deep(h1) { color: rgb(var(--c-txt)); font-size: 26px; line-height: 1.4; font-weight: 650; margin: 0 0 24px; letter-spacing: -.025em; }
.markdown-content :deep(h2) { color: rgb(var(--c-txt)); font-size: 18px; font-weight: 600; margin: 28px 0 12px; padding-bottom: 8px; border-bottom: 1px solid rgb(var(--c-line)); }
.markdown-content :deep(h3) { font-size: 16px; font-weight: 600; margin: 20px 0 10px; }
.markdown-content :deep(p) { margin: 12px 0; }
.markdown-content :deep(ul) { list-style: disc; padding-left: 24px; }
.markdown-content :deep(ol) { list-style: decimal; padding-left: 24px; }
.markdown-content :deep(li) { margin: 5px 0; }
.markdown-content :deep(blockquote) { margin: 20px 0; border-left: 3px solid rgb(var(--c-accent)); padding: 4px 18px; background: rgb(var(--c-elevated)); color: rgb(var(--c-txt3)); }
.markdown-content :deep(pre) { padding: 16px; border-radius: 8px; background: rgb(var(--c-elevated)); font-size: 12px; }
.markdown-content :deep(code) { background: rgb(var(--c-elevated)); padding: 2px 5px; border-radius: 4px; }
.markdown-content :deep(a) { color: rgb(var(--c-accent-2)); text-decoration: underline; }
.markdown-content :deep(table) { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; }
.markdown-content :deep(td), .markdown-content :deep(th) { border: 1px solid rgb(var(--c-line)); padding: 8px 12px; }
</style>
