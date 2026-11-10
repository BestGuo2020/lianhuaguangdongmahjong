<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import MahjongTile from '../MahjongTile.vue'
import { isHorseForSeat } from '../../game/core/rules/tiles'
import { defaultAvatarForSeat } from '../../game/core/presentation/avatar'
import type { RoundResult } from '../../game/core/contracts/gamePort'
import type { GamePlayer, TileType } from '../../game/core/contracts/types'
import type { GameMode } from '../../game/core/contracts/activeGamePort'
import type { TableThemeName } from '../table/three/tableTheme'
import { animeAvatarForPlayer } from '../../game/core/presentation/animeAvatarPresentation'
import { displayImageSrc } from '../../game/core/presentation/imagePreload'
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
  lastRound?: boolean
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
const emit = defineEmits<{
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
  // 结算名单每局重建：已物化的头像用本地 blob，避免每次重建都做一次协商校验（实测 0.5~1.9s）。
  return displayImageSrc(props.themeName === 'llmAnime'
    ? animeAvatarForPlayer({
      avatar: entry.avatar,
      characterId: entry.characterId,
      playerKind: entry.playerKind,
      isLlm: entry.isLlm,
    })
    : entry.avatar)
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
const titleId = useId()
const settledRound = shallowRef<{ result: RoundResult; dealer: number } | null>(null)
const roundResult = computed(() => settledRound.value?.result ?? null)
const settledDealer = computed(() => settledRound.value?.dealer ?? props.dealer)
const roundKey = computed(() => {
  const result = roundResult.value
  return result?.presentationKey ?? (result?.roundLabel ? `${result.roundLabel}:${result.honba ?? 0}` : result)
})
const rankingRequested = ref(false)
const showRanking = computed(() => finalRankingLab.value
  || (props.matchFinished && (rankingRequested.value || !roundResult.value)))
const isLastRound = computed(() => props.lastRound || props.matchFinished)
const restoredSettlement = ref(false)
let trackedResultWasOpened = false

watch([() => props.result, () => props.matchFinished], ([result, finished]) => {
  if (result && result !== settledRound.value?.result) {
    // 场末引擎可能已轮庄，买马和庄家标记仍使用该局的座位。
    settledRound.value = { result, dealer: finished ? settledDealer.value : props.dealer }
  } else if (!result && !finished) {
    settledRound.value = null
  }
}, { immediate: true })

watch([roundKey, () => props.resultVisible, showRanking], ([key, visible, ranking], [previousKey]) => {
  if (key !== previousKey) {
    rankingRequested.value = false
    trackedResultWasOpened = false
    restoredSettlement.value = false
  }
  if (!key || !visible || ranking) return
  restoredSettlement.value = trackedResultWasOpened
  trackedResultWasOpened = true
}, { immediate: true })

function continueFromRound() {
  if (isLastRound.value) rankingRequested.value = true
  if (!props.matchFinished) emit('nextRound')
}

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
  if (!resultKindLab.value) return resolveRoundResultPresentation(roundResult.value)
  return resultKindLab.value === 'draw'
    ? resolveRoundResultPresentation({ draw: true })
    : resolveRoundResultPresentation({ winType: resultKindLab.value })
})

/** 胡牌者相对庄家的座位：0=庄家(A) / 1=下家(B) / 2=对家(C) / 3=上家(D)。 */
const relativeSeat = computed<0 | 1 | 2 | 3>(() => {
  const winner = roundResult.value?.winnerIndex
  if (winner == null) return 0
  return ((winner - settledDealer.value + 4) % 4) as 0 | 1 | 2 | 3
})
</script>

<template>
  <Transition name="modal" mode="out-in">
    <div
      v-if="roundResult && resultVisible && !showRanking"
      key="round"
      class="result-backdrop round-settlement"
      :class="[`result-${resultPresentation.kind}`, { 'is-restored': restoredSettlement }]"
      :data-result-kind="resultPresentation.kind"
      :data-result-strength="resultPresentation.strength"
      :data-result-source="resultKindLab ? 'lab' : 'game'"
      :data-settlement-state="restoredSettlement ? 'restored' : 'entering'"
    >
      <section
        class="result-card settlement-card"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :class="`result-${resultPresentation.kind}`"
        :data-result-kind="resultPresentation.kind"
        :data-result-strength="resultPresentation.strength"
        :data-result-source="resultKindLab ? 'lab' : 'game'"
      >
        <h2 :id="titleId">{{ roundResult.roundLabel }} · {{ resultPresentation.label }}</h2>
        <div v-if="resultPresentation.kind !== 'draw'" class="score-total"><span>总倍数</span><strong>×{{ roundResult.totalMultiplier ?? roundResult.multiplier }}</strong><em>+{{ roundResult.totalWon ?? (roundResult.points ?? 0) * 3 }} 分</em></div>
        <div v-if="resultPresentation.kind !== 'draw' && roundResult.details?.length" class="score-details">
          <span v-for="detail in roundResult.details" :key="detail.label">
            {{ detail.label }} <b>{{ detail.points != null ? `+${detail.points} 分` : `×${detail.multiplier}` }}</b>
          </span>
        </div>
        <div v-if="resultPresentation.kind !== 'draw' && roundResult.horses?.length" class="horse-area">
          <div>
            <MahjongTile v-for="(tile, index) in roundResult.horses" :key="index" :tile="tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" :theme-name="themeName" :class="{ 'horse-hit': isHorseForSeat(tile, relativeSeat) }" small disabled />
          </div>
        </div>
        <div class="round-rankings">
          <article v-for="entry in roundResult.scoreChanges" :key="entry.playerIndex" :class="{ winner: entry.playerIndex === roundResult.winnerIndex }" :style="animeEntryStyle(entry)">
            <strong class="rank-number">{{ entry.rank }}<small>位</small></strong>
            <img :src="displayedAvatar(entry)" :alt="`${entry.name}头像`" @error="onAvatarError(entry)" />
            <span class="player-line">
              {{ entry.name }}
              <i v-if="entry.playerIndex === settledDealer" class="mark dealer">庄</i>
              <i v-if="roundResult.draw && roundResult.tenpai?.includes(entry.playerIndex)" class="mark tenpai">听</i>
            </span>
            <em :class="{ positive: entry.delta > 0, negative: entry.delta < 0 }">{{ entry.delta > 0 ? '+' : '' }}{{ entry.delta }}</em>
            <b>{{ entry.score }}</b>
          </article>
        </div>
        <div class="settlement-footer">
          <div class="result-actions">
            <button class="secondary" @click="$emit('update:resultVisible', false)">查看牌桌</button>
            <button :disabled="waitingNextRound && !matchFinished" @click="continueFromRound">
              <template v-if="waitingNextRound && !matchFinished">等待其他玩家确定...</template>
              <template v-else-if="isLastRound">查看最终排名</template>
              <template v-else>继续<template v-if="gameMode === 'remote' && continueCountdown > 0"> ({{ continueCountdown }})</template></template>
            </button>
          </div>
          <p class="result-disclaimer-note">游戏结果禁止用于赌博行为</p>
        </div>
      </section>
    </div>
    <div v-else-if="showRanking && (resultVisible || !roundResult || finalRankingLab)" key="ranking" class="result-backdrop final-backdrop" data-result-kind="final" data-result-strength="climax">
      <section class="final-board" role="dialog" aria-modal="true" :aria-labelledby="titleId"
        data-result-kind="final" data-result-strength="climax" :data-result-source="finalRankingLab ? 'lab' : 'game'">
        <p>{{ matchName }} · 对局结束</p>
        <h2 :id="titleId">最终排名</h2>
        <div class="final-ranking-panel">
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
        </div>
        <div class="final-footer">
          <button v-if="roundResult && !finalRankingLab" type="button" class="secondary" @click="rankingRequested = false">查看本局结算</button>
          <button type="button" @click="$emit('returnToLobby')">返回大厅</button>
          <p class="result-disclaimer-note">游戏结果禁止用于赌博行为</p>
        </div>
      </section>
    </div>
  </Transition>

  <button v-if="roundResult && !resultVisible && !finalRankingLab" class="result-reopen" @click="$emit('update:resultVisible', true)">
    {{ showRanking ? '查看最终排名' : '查看结算' }}
  </button>
  <button
    v-if="gameMode === 'remote' && roundResult && !resultVisible && !isLastRound"
    class="result-reopen continue"
    :disabled="waitingNextRound"
    @click="$emit('nextRound')"
  ><template v-if="waitingNextRound">等待其他玩家确定...</template><template v-else>继续<template v-if="continueCountdown > 0"> ({{ continueCountdown }})</template></template></button>
</template>
