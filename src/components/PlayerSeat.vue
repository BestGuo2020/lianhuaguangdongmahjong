<script setup lang="ts">
import { ref, watch } from 'vue'
import MahjongTile from './MahjongTile.vue'
import { defaultAvatarForSeat } from '../game/core/presentation/avatar'
import type { GamePlayer, TileType } from '../game/core/contracts/types'

const props = withDefaults(defineProps<{
  player: GamePlayer
  active?: boolean
  actionActive?: boolean
  scoreDelta?: number
  scoreFlowId?: number
  position: string
  dealer?: boolean
  renderHand?: boolean
  renderMelds?: boolean
  jokerTiles?: TileType[]
}>(), { active: false, actionActive: false, scoreDelta: 0, scoreFlowId: 0, dealer: false, renderHand: true, renderMelds: true, jokerTiles: undefined })

// 外部头像（联机真人）加载失败 → 回退到本地座位默认头像
const avatarSrc = ref(props.player.avatar)
watch(() => props.player.avatar, (value) => { avatarSrc.value = value })
function onAvatarError() {
  avatarSrc.value = defaultAvatarForSeat(props.player.seat)
}
</script>

<template>
  <section class="player-seat" :class="[`seat-${position}`, { active, 'action-active': actionActive }]">
    <div class="avatar-wrap">
      <span v-if="dealer" class="dealer-badge">庄</span>
      <img class="avatar" :src="avatarSrc" :alt="`${player.name}头像`" @error="onAvatarError" />
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
        v-for="index in Math.min(player.concealedTileCount ?? player.hand.length, 13)"
        :key="index"
        tile="back"
        hidden
        small
        disabled
      />
    </div>
    <div v-if="renderMelds && player.melds.length" class="seat-melds">
      <div v-for="(meld, index) in player.melds" :key="`${meld.type}-${index}`" class="mini-meld">
        <MahjongTile v-for="(tile, tileIndex) in meld.tiles" :key="tileIndex" :tile="tile" :joker-tiles="jokerTiles" small disabled />
      </div>
    </div>
  </section>
</template>
