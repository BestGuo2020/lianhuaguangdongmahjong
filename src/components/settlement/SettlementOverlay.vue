<script setup lang="ts">
import { computed } from 'vue'
import MahjongTile from '../MahjongTile.vue'
import { isHorseForSeat } from '../../game/core/rules/tiles'
import { defaultAvatarForSeat } from '../../game/core/presentation/avatar'
import type { RoundResult } from '../../game/core/contracts/gamePort'
import type { GamePlayer, TileType } from '../../game/core/contracts/types'
import type { GameMode } from '../../game/core/contracts/activeGamePort'
import type { TableThemeName } from '../table/three/tableTheme'
import { animeAvatarForPlayer } from '../../game/core/presentation/animeAvatarPresentation'

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
  /** 真人座位集合：仅这些座位在多人结算页显示举报按钮（AI 补位不显示）。 */
  humanSeats?: number[]
  jokerTiles?: TileType[]
  wildcardTiles?: TileType[]
  themeName?: TableThemeName
}

const props = defineProps<Props>()
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

function displayedAvatar(entry?: {
  avatar?: string
  characterId?: string
  playerKind?: 'human' | 'llm' | 'bot'
  isLlm?: boolean
}) {
  if (!entry?.avatar) return ''
  return props.themeName === 'llmAnime'
    ? animeAvatarForPlayer({
      avatar: entry.avatar,
      characterId: entry.characterId,
      playerKind: entry.playerKind,
      isLlm: entry.isLlm,
    })
    : entry?.avatar
}

/** 结算标题：莲花麻将按 winType 展示（天胡/地胡/点炮），否则按旧逻辑。 */
const winLabel = computed(() => {
  const result = props.result
  if (!result) return ''
  if (result.draw) return '流局'
  switch (result.winType) {
    case 'tianhu': return '天胡'
    case 'dihu': return '地胡'
    case 'robbed-kong': return '抢杠胡'
    case 'self-draw': return '自摸'
    case 'discard': return '点炮'
    default: return result.robbedKong ? '抢杠胡' : '自摸'
  }
})

/** 胡牌者相对庄家的座位：0=庄家(A) / 1=下家(B) / 2=对家(C) / 3=上家(D)。 */
const relativeSeat = computed<0 | 1 | 2 | 3>(() => {
  const winner = props.result?.winnerIndex
  if (winner == null) return 0
  return ((winner - props.dealer + 4) % 4) as 0 | 1 | 2 | 3
})
</script>

<template>
  <Transition name="modal">
    <div v-if="result && resultVisible && !matchFinished" class="result-backdrop round-settlement">
      <section class="result-card settlement-card">
        <h2>{{ result.roundLabel }} · {{ winLabel }}</h2>
        <div v-if="!result.draw" class="score-total"><span>总倍数</span><strong>×{{ result.totalMultiplier ?? result.multiplier }}</strong><em>+{{ result.totalWon ?? result.points * 3 }} 分</em></div>
        <div v-if="result.details?.length" class="score-details">
          <span v-for="detail in result.details" :key="detail.label">
            {{ detail.label }} <b>{{ detail.points != null ? `+${detail.points} 分` : `×${detail.multiplier}` }}</b>
          </span>
        </div>
        <div v-if="result.horses?.length" class="horse-area">
          <div>
            <MahjongTile v-for="(tile, index) in result.horses" :key="index" :tile="tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" :theme-name="themeName" :class="{ 'horse-hit': isHorseForSeat(tile, relativeSeat) }" small disabled />
          </div>
        </div>
        <div class="round-rankings">
          <article v-for="entry in result.scoreChanges" :key="entry.playerIndex" :class="{ winner: entry.playerIndex === result.winnerIndex }">
            <strong class="rank-number">{{ entry.rank }}<small>位</small></strong>
            <img :src="displayedAvatar(entry)" :alt="`${entry.name}头像`" @error="onAvatarError(entry)" />
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
            <img :src="displayedAvatar(entry)" :alt="`${entry.name}头像`" @error="onAvatarError(entry)" />
            <div class="final-name">
              <strong>{{ entry.name }}</strong>
              <small v-if="entry.playerIndex === 0">你</small>
              <button
                v-if="gameMode === 'remote' && entry.playerIndex !== 0 && playerId && humanSeats?.includes(entry.playerIndex)"
                class="report-link" @click="$emit('report', entry.name)"
              >举报</button>
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
