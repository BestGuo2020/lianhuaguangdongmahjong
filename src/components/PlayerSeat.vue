<script setup>
import MahjongTile from './MahjongTile.vue'

defineProps({
  player: { type: Object, required: true },
  active: Boolean,
  position: { type: String, required: true },
  dealer: Boolean,
  renderHand: { type: Boolean, default: true },
  renderMelds: { type: Boolean, default: true },
})
</script>

<template>
  <section class="player-seat" :class="[`seat-${position}`, { active }]">
    <div class="avatar-wrap">
      <span v-if="dealer" class="dealer-badge">庄</span>
      <div class="avatar">{{ player.avatar }}</div>
      <div class="player-info">
        <strong>{{ player.name }}</strong>
        <span>{{ player.score }}</span>
      </div>
      <span v-if="active" class="turn-dot"></span>
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
