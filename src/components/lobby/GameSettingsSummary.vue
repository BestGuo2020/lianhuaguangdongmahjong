<script setup lang="ts">
interface Props {
  matchName: string
  matchDescription: string
  ruleName: string
  ruleDescription: string
}

defineProps<Props>()
defineEmits<{ selectMatch: []; selectRule: [] }>()
</script>

<template>
  <section class="game-settings" aria-label="对局设置">
    <p class="game-settings-title">对局设置</p>
    <button type="button" @click="$emit('selectMatch')">
      <span>场次</span>
      <strong>{{ matchName }}</strong>
      <small>{{ matchDescription }}</small>
      <i aria-hidden="true"></i>
    </button>
    <button type="button" @click="$emit('selectRule')">
      <span>玩法</span>
      <strong>{{ ruleName }}</strong>
      <small>{{ ruleDescription }}</small>
      <i aria-hidden="true"></i>
    </button>
  </section>
</template>
