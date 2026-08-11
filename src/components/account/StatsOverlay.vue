<script setup lang="ts">
import { ref, watch } from 'vue'
import { getPlayerStats, getPlayerStatsById, type PlayerStats } from '../../game/online/api/accountApi'

interface Props {
  open: boolean
  playerId: string
  nickname: string
  fallbackNickname: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const stats = ref<PlayerStats | null>(null)
const loading = ref(false)
let requestSerial = 0

watch(() => props.open, async (open) => {
  if (!open) return
  const serial = ++requestSerial
  loading.value = true
  stats.value = null
  try {
    let next = await getPlayerStatsById(props.playerId)
    if (next.matches === 0) {
      const name = props.nickname || props.fallbackNickname.trim()
      if (name) {
        const byName = await getPlayerStats(name)
        if (byName.matches > 0) next = byName
      }
    }
    if (serial === requestSerial) stats.value = next
  } catch {
    if (serial === requestSerial) stats.value = null
  } finally {
    if (serial === requestSerial) loading.value = false
  }
})
</script>

<template>
  <Transition name="modal">
    <div v-if="open" class="result-backdrop round-settlement">
      <section class="result-card settlement-card stats-card">
        <h2>个人战绩</h2>
        <p class="stats-nickname">{{ nickname || fallbackNickname }}</p>
        <div v-if="loading" class="stats-loading">加载中…</div>
        <template v-else-if="stats">
          <div class="stats-grid">
            <article><b>{{ stats.matches }}</b><span>场次</span></article>
            <article><b>{{ stats.hands }}</b><span>参与局数</span></article>
            <article><b>{{ stats.wins }}</b><span>胡牌局数</span></article>
            <article><b :class="{ positive: stats.totalDelta > 0, negative: stats.totalDelta < 0 }">{{ stats.totalDelta > 0 ? '+' : '' }}{{ stats.totalDelta }}</b><span>净胜分</span></article>
          </div>
        </template>
        <p v-else class="stats-empty">暂无战绩记录，快去打一局吧！</p>
        <div class="result-actions">
          <button @click="emit('update:open', false)">关闭</button>
        </div>
      </section>
    </div>
  </Transition>
</template>
