<script setup lang="ts">
defineProps<{ name: 'theme' | 'exit' | 'audio' | 'mute' | 'rules' | 'autoplay' | 'waits' | 'close' }>()
</script>

<template>
  <svg class="table-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <g v-if="name === 'theme'" transform="rotate(45 12 12)">
      <rect x="4.5" y="4.5" width="6" height="6" rx="1.3" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1.3" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1.3" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1.3" />
    </g>
    <path v-else-if="name === 'exit'" d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M9 12h12m-4-4 4 4-4 4" />
    <g v-else-if="name === 'audio' || name === 'mute'">
      <path d="M3.5 9h4l5-4v14l-5-4h-4z" />
      <path v-if="name === 'audio'" d="M16 8.5c1.5 1.8 1.5 5.2 0 7M19 6c3 3.2 3 8.8 0 12" />
      <path v-else d="m16.5 9.5 5 5m0-5-5 5" />
    </g>
    <path v-else-if="name === 'rules'" d="M3.5 5.5c3-1 5.8-.5 8.5 1.5 2.7-2 5.5-2.5 8.5-1.5V18c-3-1-5.8-.5-8.5 1.5C9.3 17.5 6.5 17 3.5 18V5.5ZM12 7v12.5" />
    <g v-else-if="name === 'autoplay'">
      <rect x="5" y="8" width="14" height="12" rx="3" />
      <path d="M12 8V5M2.5 12v4m19-4v4M10 17h4" />
      <g fill="currentColor" stroke="none">
        <circle cx="12" cy="4" r="1.4" />
        <circle cx="9" cy="13" r="1.15" />
        <circle cx="15" cy="13" r="1.15" />
      </g>
    </g>
    <g v-else-if="name === 'waits'">
      <path d="M10 20.5H5.5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2V8" />
      <circle cx="15.5" cy="14.5" r="4.2" />
      <path d="m18.5 17.5 3 3" />
      <g fill="currentColor" stroke="none">
        <circle cx="8.1" cy="8" r="1.15" />
        <circle cx="8.1" cy="12" r="1.15" />
        <circle cx="8.1" cy="16" r="1.15" />
      </g>
    </g>
    <path v-else d="m6 6 12 12M18 6 6 18" />
  </svg>
</template>

<style scoped>
.table-control-icon {
  display: block;
  flex: none;
  width: var(--table-control-icon-size, 24px);
  height: auto;
}
</style>
