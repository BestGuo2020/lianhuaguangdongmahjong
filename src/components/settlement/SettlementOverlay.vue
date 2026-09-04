<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import MahjongTile from '../MahjongTile.vue'
import { isHorseForSeat } from '../../game/core/rules/tiles'
import { defaultAvatarForSeat } from '../../game/core/presentation/avatar'
import type { RoundResult } from '../../game/core/contracts/gamePort'
import type { GamePlayer, TileType } from '../../game/core/contracts/types'
import type { GameMode } from '../../game/core/contracts/activeGamePort'
import type { TableThemeName } from '../table/three/tableTheme'
import { animeAvatarForPlayer } from '../../game/core/presentation/animeAvatarPresentation'
import { animeCharacterAccent } from '../../game/core/presentation/animeCharacterPalette'
import {
  resolveRoundResultPresentation,
  type RoundResultPresentationKind,
} from '../../theme/themeEventPresentation'

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

function animeEntryStyle(entry?: { characterId?: string }) {
  return props.themeName === 'llmAnime'
    ? { '--anime-accent': animeCharacterAccent(entry?.characterId) }
    : undefined
}

const resultKindLabCandidate = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get('resultKindLab') as RoundResultPresentationKind | null
  : null
const resultKindLabValues = new Set<RoundResultPresentationKind>([
  'draw', 'self-draw', 'discard', 'robbed-kong', 'tianhu', 'dihu',
])
const resultKindLab = ref(resultKindLabCandidate && resultKindLabValues.has(resultKindLabCandidate)
  ? resultKindLabCandidate
  : null)
const finalRankingLab = ref(import.meta.env.DEV && new URLSearchParams(window.location.search).has('finalRankLab'))
const restoredSettlement = ref(false)
let trackedResult: RoundResult | null = null
let trackedResultWasOpened = false

watch([() => props.result, () => props.resultVisible], ([result, visible]) => {
  if (result !== trackedResult) {
    trackedResult = result
    trackedResultWasOpened = false
    restoredSettlement.value = false
  }
  if (!result || !visible) return
  restoredSettlement.value = trackedResultWasOpened
  trackedResultWasOpened = true
}, { immediate: true })
type ResultKindLabWindow = Window & {
  __setRoundResultKindLab?: (kind: RoundResultPresentationKind | null) => void
  __setFinalRankingLab?: (active: boolean) => void
}
const resultKindLabWindow = window as ResultKindLabWindow
const setRoundResultKindLab = (kind: RoundResultPresentationKind | null) => {
  resultKindLab.value = kind && resultKindLabValues.has(kind) ? kind : null
}
if (import.meta.env.DEV) resultKindLabWindow.__setRoundResultKindLab = setRoundResultKindLab
const setFinalRankingLab = (active: boolean) => { finalRankingLab.value = Boolean(active) }
if (import.meta.env.DEV) resultKindLabWindow.__setFinalRankingLab = setFinalRankingLab
onBeforeUnmount(() => {
  if (resultKindLabWindow.__setRoundResultKindLab === setRoundResultKindLab) {
    delete resultKindLabWindow.__setRoundResultKindLab
  }
  if (resultKindLabWindow.__setFinalRankingLab === setFinalRankingLab) {
    delete resultKindLabWindow.__setFinalRankingLab
  }
})
const resultPresentation = computed(() => {
  if (!resultKindLab.value) return resolveRoundResultPresentation(props.result)
  return resultKindLab.value === 'draw'
    ? resolveRoundResultPresentation({ draw: true })
    : resolveRoundResultPresentation({ winType: resultKindLab.value })
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
    <div
      v-if="result && resultVisible && !matchFinished && !finalRankingLab"
      class="result-backdrop round-settlement"
      :class="[`result-${resultPresentation.kind}`, { 'is-restored': restoredSettlement }]"
      :data-result-kind="resultPresentation.kind"
      :data-result-strength="resultPresentation.strength"
      :data-result-source="resultKindLab ? 'lab' : 'game'"
      :data-settlement-state="restoredSettlement ? 'restored' : 'entering'"
    >
      <section
        class="result-card settlement-card"
        :class="`result-${resultPresentation.kind}`"
        :data-result-kind="resultPresentation.kind"
        :data-result-strength="resultPresentation.strength"
        :data-result-source="resultKindLab ? 'lab' : 'game'"
      >
        <h2>{{ result.roundLabel }} · {{ resultPresentation.label }}</h2>
        <div v-if="resultPresentation.kind !== 'draw'" class="score-total"><span>总倍数</span><strong>×{{ result.totalMultiplier ?? result.multiplier }}</strong><em>+{{ result.totalWon ?? result.points * 3 }} 分</em></div>
        <div v-if="resultPresentation.kind !== 'draw' && result.details?.length" class="score-details">
          <span v-for="detail in result.details" :key="detail.label">
            {{ detail.label }} <b>{{ detail.points != null ? `+${detail.points} 分` : `×${detail.multiplier}` }}</b>
          </span>
        </div>
        <div v-if="resultPresentation.kind !== 'draw' && result.horses?.length" class="horse-area">
          <div>
            <MahjongTile v-for="(tile, index) in result.horses" :key="index" :tile="tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" :theme-name="themeName" :class="{ 'horse-hit': isHorseForSeat(tile, relativeSeat) }" small disabled />
          </div>
        </div>
        <div class="round-rankings">
          <article v-for="entry in result.scoreChanges" :key="entry.playerIndex" :class="{ winner: entry.playerIndex === result.winnerIndex }" :style="animeEntryStyle(entry)">
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
        <div class="settlement-footer">
          <div class="result-actions">
            <button class="secondary" @click="$emit('update:resultVisible', false)">查看牌桌</button>
            <button :disabled="waitingNextRound" @click="$emit('nextRound')">
              <template v-if="waitingNextRound">等待其他玩家确定...</template>
              <template v-else>继续<template v-if="gameMode === 'remote' && continueCountdown > 0"> ({{ continueCountdown }})</template></template>
            </button>
          </div>
          <p class="result-disclaimer-note">游戏结果禁止用于赌博行为</p>
        </div>
      </section>
    </div>
  </Transition>

  <Transition name="final-board">
    <div v-if="matchFinished || finalRankingLab" class="result-backdrop final-backdrop" data-result-kind="final" data-result-strength="climax">
      <section class="final-board" data-result-kind="final" data-result-strength="climax" :data-result-source="finalRankingLab ? 'lab' : 'game'">
        <p>{{ matchName }} · 对局结束</p>
        <h2>最终排名</h2>
        <div class="final-rankings">
          <article v-for="entry in standings" :key="entry.playerIndex" :class="[`rank-${entry.rank}`, { self: entry.playerIndex === 0 }]" :style="animeEntryStyle(entry)">
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
        <div class="settlement-footer final-footer">
          <button @click="$emit('returnToLobby')">返回大厅</button>
          <p class="result-disclaimer-note">游戏结果禁止用于赌博行为</p>
        </div>
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
