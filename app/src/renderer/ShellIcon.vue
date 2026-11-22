<script setup lang="ts">
defineProps<{ name: 'lock' | 'chevron' | 'flash' | 'ruffle' | 'check' | 'error' | 'close' }>()
</script>

<template>
  <svg class="shell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <g v-if="name === 'lock'">
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
    </g>
    <path v-else-if="name === 'chevron'" d="m6 9 6 6 6-6" />
    <path v-else-if="name === 'flash'" d="m13 2-8 12h6l-1 8 9-12h-6z" />
    <path v-else-if="name === 'ruffle'" d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />
    <path v-else-if="name === 'check'" d="m5 12 4 4 10-10" />
    <g v-else-if="name === 'error'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6m0 4h.01" />
    </g>
    <path v-else d="m6 6 12 12M18 6 6 18" />
  </svg>
</template>

<style>
.shell-icon { width: 16px; height: 16px; flex: none; }
</style>
