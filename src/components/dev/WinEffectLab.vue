<script setup lang="ts">
defineProps<{ open: boolean }>()
const emit = defineEmits<{
  previewWin: [seat: number, options?: { robbedKong?: boolean }]
  previewKong: [mode: 'concealed' | 'added' | 'both']
  previewFourRed: []
}>()

const seats = ['本家', '下家', '对家', '上家']
</script>

<template>
  <aside v-if="open" class="win-effect-lab" aria-label="胡牌特效测试面板">
    <strong>胡牌特效测试</strong>
    <div v-for="(seat, index) in seats" :key="seat">
      <span>{{ seat }}</span>
      <button :data-testid="`win-self-${index}`" @click="emit('previewWin', index)">自摸</button>
      <button :data-testid="`win-rob-${index}`" @click="emit('previewWin', index, { robbedKong: true })">抢杠胡</button>
    </div>
    <strong>杠选牌测试</strong>
    <div class="kong-debug">
      <span>本家</span>
      <button data-testid="kong-concealed" @click="emit('previewKong', 'concealed')">暗杠</button>
      <button data-testid="kong-added" @click="emit('previewKong', 'added')">补杠</button>
      <button data-testid="kong-both" @click="emit('previewKong', 'both')">双杠</button>
    </div>
    <strong>红中测试</strong>
    <div class="kong-debug">
      <span>本家</span>
      <button data-testid="four-red" @click="emit('previewFourRed')">四红中</button>
    </div>
  </aside>
</template>
