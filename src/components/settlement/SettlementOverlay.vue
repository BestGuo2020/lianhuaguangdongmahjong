<script setup lang="ts">
import MahjongTile from '../MahjongTile.vue'
import { isHorse } from '../../game/core/rules/tiles'
import { defaultAvatarForSeat } from '../../game/core/presentation/avatar'
import type { RoundResult } from '../../game/core/contracts/gamePort'
import type { GamePlayer } from '../../game/core/contracts/types'
import type { GameMode } from '../../game/core/contracts/activeGamePort'

type Standing = GamePlayer & { playerIndex: number; rank: number }

interface Props {
  result: RoundResult | null
  resultVisible: boolean
  matchFinished: boolean
  dealer: number
  waitingNextRound: boolean
  gameMode: GameMode
  continueCountdown: number
  matchName: string
  standings: Standing[]
  playerId: string
}

defineProps<Props>()
defineEmits<{
  'update:resultVisible': [value: boolean]
  nextRound: []
  returnToLobby: []
  report: [name: string]
}>()

function onAvatarError(entry?: { avatar?: string; seat?: number; fallbackAvatar?: string }) {
  if (!entry) return
  const target = entry.fallbackAvatar ?? (entry.seat != null ? defaultAvatarForSeat(entry.seat) : '')
  if (target && entry.avatar !== target) entry.avatar = target
}
</script>

<template>
  <Transition name="modal">
    <div v-if="result && resultVisible && !matchFinished" class="result-backdrop round-settlement">
      <section class="result-card settlement-card">
        <h2>{{ result.roundLabel }} · {{ result.draw ? '流局' : (result.robbedKong ? '抢杠胡' : '自摸') }}</h2>
        <div v-if="!result.draw" class="score-total"><span>总倍数</span><strong>×{{ result.totalMultiplier ?? result.multiplier }}</strong><em>+{{ result.totalWon ?? result.points * 3 }} 分</em></div>
        <div v-if="result.details?.length" class="score-details">
          <span v-for="detail in result.details" :key="detail.label">
            {{ detail.label }} <b>{{ detail.points != null ? `+${detail.points} 分` : `×${detail.multiplier}` }}</b>
          </span>
        </div>
        <div v-if="result.horses?.length" class="horse-area">
          <div>
            <MahjongTile v-for="(tile, index) in result.horses" :key="index" :tile="tile" :class="{ 'horse-hit': isHorse(tile) }" small disabled />
          </div>
        </div>
        <div class="round-rankings">
          <article v-for="entry in result.scoreChanges" :key="entry.playerIndex" :class="{ winner: entry.playerIndex === result.winnerIndex }">
            <strong class="rank-number">{{ entry.rank }}<small>位</small></strong>
            <img :src="entry.avatar" :alt="`${entry.name}头像`" @error="onAvatarError(entry)" />
            <span class="player-line">
              {{ entry.name }}
              <i v-if="entry.playerIndex === dealer" class="mark dealer">庄</i>
              <i v-if="result.draw && result.tenpai?.includes(entry.playerIndex)" class="mark tenpai">听</i>
            </span>
            <em :class="{ positive: entry.delta > 0, negative: entry.delta < 0 }">{{ entry.delta > 0 ? '+' : '' }}{{ entry.delta }}</em>
            <b>{{ entry.score }}</b>
          </article>
        </div>
        <div class="result-actions">
          <button class="secondary" @click="$emit('update:resultVisible', false)">查看牌桌</button>
          <button :disabled="waitingNextRound" @click="$emit('nextRound')">
            <template v-if="waitingNextRound">等待其他玩家确定...</template>
            <template v-else>继续<template v-if="gameMode === 'remote' && continueCountdown > 0"> ({{ continueCountdown }})</template></template>
          </button>
        </div>
        <p class="result-disclaimer-note">游戏结果禁止用于赌博行为</p>
      </section>
    </div>
  </Transition>

  <Transition name="final-board">
    <div v-if="matchFinished" class="result-backdrop final-backdrop">
      <section class="final-board">
        <p>{{ matchName }} · 对局结束</p>
        <h2>最终排名</h2>
        <div class="final-rankings">
          <article v-for="entry in standings" :key="entry.playerIndex" :class="[`rank-${entry.rank}`, { self: entry.playerIndex === 0 }]">
            <div class="final-rank"><b>{{ entry.rank }}</b><span>位</span></div>
            <img :src="entry.avatar" :alt="`${entry.name}头像`" @error="onAvatarError(entry)" />
            <div class="final-name">
              <strong>{{ entry.name }}</strong>
              <small v-if="entry.playerIndex === 0">你</small>
              <button v-if="entry.playerIndex !== 0 && playerId" class="report-link" @click="$emit('report', entry.name)">举报</button>
            </div>
            <em>{{ entry.score }}</em>
          </article>
        </div>
        <button @click="$emit('returnToLobby')">返回大厅</button>
        <p class="result-disclaimer-note">游戏结果禁止用于赌博行为</p>
      </section>
    </div>
  </Transition>

  <button v-if="result && !resultVisible && !matchFinished" class="result-reopen" @click="$emit('update:resultVisible', true)">查看结算</button>
  <button
    v-if="gameMode === 'remote' && result && !resultVisible && !matchFinished"
    class="result-reopen continue"
    :disabled="waitingNextRound"
    @click="$emit('nextRound')"
  ><template v-if="waitingNextRound">等待其他玩家确定...</template><template v-else>继续<template v-if="continueCountdown > 0"> ({{ continueCountdown }})</template></template></button>
</template>
