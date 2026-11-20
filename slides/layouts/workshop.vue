<script setup lang="ts">
import { computed } from 'vue'
import { useNav } from '@slidev/client/composables/useNav.ts'
import config from '../workshop.config.json'

const nav = useNav()
const hasWorkbench = computed(() => {
  const mode = nav.currentFrontmatter.value.workbench
  return mode === 'integrated' || mode === 'editor' || mode === 'terminal'
    || (mode !== 'hidden' && config.defaultMode !== 'hidden')
})
const layoutStyle = computed(() => ({ '--workbench-height': `${config.layout.workbenchHeight}%` }))
</script>

<template>
  <div class="slidev-layout workshop-layout" :class="{ 'with-workbench': hasWorkbench }" :style="layoutStyle">
    <slot />
  </div>
</template>

<style>
.slidev-layout.workshop-layout.with-workbench {
  height: calc(100% - var(--workbench-height, 50%));
  overflow: auto;
}
</style>
