<script setup lang="ts">
import MahjongTile from './MahjongTile.vue'
import type { GamePlayer } from '../game/types'

withDefaults(defineProps<{
  player: GamePlayer
  active?: boolean
  actionActive?: boolean
  scoreDelta?: number
  scoreFlowId?: number
  position: string
  dealer?: boolean
  renderHand?: boolean
  renderMelds?: boolean
}>(), { active: false, actionActive: false, scoreDelta: 0, scoreFlowId: 0, dealer: false, renderHand: true, renderMelds: true })
</script>

<template>
  <section class="player-seat" :class="[`seat-${position}`, { active, 'action-active': actionActive }]">
    <div class="avatar-wrap">
      <span v-if="dealer" class="dealer-badge">庄</span>
      <img class="avatar" :src="player.avatar" :alt="`${player.name}头像`" />
      <div class="player-info">
        <strong>{{ player.name }}</strong>
        <span>{{ player.score }}</span>
      </div>
      <span v-if="active" class="turn-dot"></span>
      <Transition name="score-flow">
        <strong
          v-if="scoreDelta"
          :key="`${scoreFlowId}-${player.seat}`"
          class="score-delta"
          :class="scoreDelta > 0 ? 'positive' : 'negative'"
        >{{ scoreDelta > 0 ? '+' : '' }}{{ scoreDelta }}</strong>
      </Transition>
    </div>
    <div v-if="renderHand" class="opponent-hand" :class="`hand-${position}`">
      <MahjongTile
        v-for="index in Math.min(player.hand.length, 13)"
        :key="index"
        tile="back"
        hidden
        small
        disabled
      />
    </div>
    <div v-if="renderMelds && player.melds.length" class="seat-melds">
      <div v-for="(meld, index) in player.melds" :key="`${meld.type}-${index}`" class="mini-meld">
        <MahjongTile v-for="(tile, tileIndex) in meld.tiles" :key="tileIndex" :tile="tile" small disabled />
      </div>
    </div>
  </section>
</template>
