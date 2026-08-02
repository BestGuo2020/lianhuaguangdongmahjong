<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import MahjongTile from './components/MahjongTile.vue'
import MahjongTable3D from './components/MahjongTable3D.vue'
import PlayerSeat from './components/PlayerSeat.vue'
import RulesPanel from './components/RulesPanel.vue'
import { isHorse } from './game/tiles'
import { BASE_SCORE } from './game/rules'
import { useGame } from './game/useGame'
import { useAudio } from './game/useAudio'
import { splitWinningTile } from './game/winEffect'
import type { MatchType } from './game/types'

const rulesOpen = ref(false)
const resultVisible = ref(true)
const selectedMatch = ref<MatchType>('east')
const imageBase = `${import.meta.env.BASE_URL}img/`
const waitsOpen = ref(false)
const winEffectLab = import.meta.env.DEV && new URLSearchParams(window.location.search).has('winEffectLab')
const winEffectLabSeats = ['本家', '下家', '对家', '上家']
const requiresLandscape = ref(false)
const orientationMessage = ref('')
const { soundOn, playEffect, playEffectAndWait, startBgm } = useAudio()

function updateOrientationGate() {
  const isPortrait = window.matchMedia('(orientation: portrait)').matches
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
  const isMobileViewport = Math.min(window.innerWidth, window.innerHeight) <= 1024
  requiresLandscape.value = isPortrait && isTouchDevice && isMobileViewport

  if (!requiresLandscape.value) orientationMessage.value = ''
}

async function enterLandscapeFullscreen() {
  orientationMessage.value = ''

  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    }

    const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> }
    if (orientation?.lock) {
      await orientation.lock('landscape')
    }
  } catch (error) {
    orientationMessage.value = '当前浏览器无法自动旋转，请将手机横置后继续'
  } finally {
    updateOrientationGate()
  }
}

onMounted(() => {
  updateOrientationGate()
  window.addEventListener('resize', updateOrientationGate)
  window.addEventListener('orientationchange', updateOrientationGate)
  screen.orientation?.addEventListener?.('change', updateOrientationGate)
})

onUnmounted(() => {
  window.removeEventListener('resize', updateOrientationGate)
  window.removeEventListener('orientationchange', updateOrientationGate)
  screen.orientation?.removeEventListener?.('change', updateOrientationGate)
})

const {
  phase, players, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
  actionPrompt, announcement, result, winEffect, winPresentation, revealHands, winningPlayerIndex,
  round, dealer, user, isUserTurn, userCanHu,
  matchName, matchFinished, honba, roundLabel, standings,
  userKongs, userCurrentWaits, userTingOptions, userDiscardWaits, dealAnimation, openingStage, diceValues, startGame, selectTile, userDiscard, userPass, userPeng, userGangFromDiscard,
  userGang, userHu, nextRound, returnToLobby, debugPreviewWin,
} = useGame({ playSound: playEffect, playSoundAndWait: playEffectAndWait })

function startGameWithAudio() {
  startBgm()
  startGame(selectedMatch.value)
}

const seatPosition = ['bottom', 'right', 'top', 'left']

watch(result, (value) => {
  resultVisible.value = Boolean(value)
})

watch(userDiscardWaits, (value) => {
  waitsOpen.value = Boolean(value)
})

watch(isUserTurn, (value) => {
  if (!value) waitsOpen.value = false
})

const activeWaits = computed(() => userDiscardWaits.value || (!isUserTurn.value ? userCurrentWaits.value : null))
const displayedUserHand = computed(() => {
  if (winPresentation.value?.winnerIndex !== 0) return user.value.hand
  return splitWinningTile(user.value.hand, winPresentation.value).hand
})
</script>

<template>
  <div v-if="requiresLandscape" class="orientation-gate" role="dialog" aria-modal="true" aria-labelledby="orientation-title">
    <div class="orientation-card">
      <div class="phone-rotate-icon" aria-hidden="true"><span></span></div>
      <p class="eyebrow">LANDSCAPE MODE</p>
      <h2 id="orientation-title">请横屏游玩</h2>
      <p>为了完整显示牌桌，请进入全屏并将手机旋转为横屏。</p>
      <button type="button" @click="enterLandscapeFullscreen">进入全屏横屏</button>
      <small v-if="orientationMessage" role="status">{{ orientationMessage }}</small>
    </div>
  </div>
  <main class="game-app">
    <div class="wood-frame">
      <div class="felt-table" :class="{ 'has-three-scene': players.length }">
        <header class="top-bar">
          <div class="brand-mini"><span v-if="!players.length">莲花广麻</span></div>
          <div class="round-info">{{ matchName }} · {{ roundLabel }}<span v-if="honba"> · {{ honba }}本场</span></div>
          <nav>
            <button class="icon-button" :aria-label="soundOn ? '关闭声音' : '开启声音'" @click="soundOn = !soundOn">
              <img :src="`${imageBase}${soundOn ? 'audio.png' : 'mute.png'}`" alt="" />
            </button>
            <button class="icon-button" aria-label="查看规则" @click="rulesOpen = true">
              <img :src="`${imageBase}manual.png`" alt="" />
            </button>
          </nav>
        </header>
        <div class="table-depth" aria-hidden="true">
          <i class="table-edge edge-top"></i>
          <i class="table-edge edge-right"></i>
          <i class="table-edge edge-bottom"></i>
          <i class="table-edge edge-left"></i>
          <span class="felt-emblem">莲花广麻</span>
        </div>

        <template v-if="players.length">
          <MahjongTable3D
            :players="players"
            :current-player="currentPlayer"
            :last-discard="lastDiscard"
            :wall-count="wallCount"
            :reveal-hands="revealHands"
            :winner-index="winningPlayerIndex"
            :win-effect="winEffect"
            :win-presentation="winPresentation"
            :deal-animation="dealAnimation"
            :opening-stage="openingStage"
            :dice-values="diceValues"
            :dealer-index="dealer"
          />
          <PlayerSeat
            v-for="(player, index) in players.slice(1)"
            :key="player.name"
            :player="player"
            :position="seatPosition[index + 1]"
            :active="currentPlayer === index + 1"
            :dealer="dealer === index + 1"
            :render-hand="false"
            :render-melds="false"
          />

          <Transition name="announce">
            <div v-if="announcement" :key="announcement.id" class="announcement" :class="announcement.tone">
              <span>{{ announcement.text }}</span>
            </div>
          </Transition>

          <Transition name="opening-cue" mode="out-in">
            <div v-if="openingStage === 'start'" key="start" class="opening-overlay start-cue">
              <span>{{ matchName }} · {{ roundLabel }}</span>
              <strong>对局开始</strong>
              <i></i>
            </div>
          </Transition>

          <section class="user-area">
            <div class="user-identity" :class="{ active: currentPlayer === 0 }">
              <span v-if="dealer === 0" class="dealer-badge">庄</span>
              <img class="avatar" :src="user.avatar" :alt="`${user.name}头像`" />
              <div class="player-info"><strong>{{ user.name }}</strong><span>{{ user.score }}</span></div>
            </div>
            <div class="hand-rack" :class="{ playable: isUserTurn, dealing: phase === 'dealing', 'has-melds': user.melds.length }">
              <MahjongTile
                v-for="(tile, index) in displayedUserHand"
                :key="`${tile}-${index}`"
                :tile="tile"
                :selected="selectedIndex === index"
                :drawn="user.drawnTileIndex === index"
                :disabled="!isUserTurn"
                @choose="selectTile(index)"
              />
            </div>
          </section>

          <div v-if="isUserTurn || actionPrompt" class="turn-timer" :class="{ 'prompt-timer': actionPrompt }">
            <span>{{ turnSeconds }}</span>
          </div>

          <div v-if="activeWaits && waitsOpen" class="waiting-tip compact-waiting-tip">
            <template v-if="activeWaits.any">
              <strong>听任意</strong>
              <em>{{ activeWaits.remaining }}张</em>
            </template>
            <template v-else>
              <div class="waiting-tiles">
                <div v-for="item in activeWaits.tiles" :key="item.tile">
                  <MahjongTile :tile="item.tile" small disabled />
                  <small>{{ item.remaining }}张</small>
                </div>
              </div>
            </template>
          </div>

          <div v-if="actionPrompt || isUserTurn || userCurrentWaits" class="action-bar">
              <button
                v-if="userCurrentWaits || userTingOptions.length"
                class="action waiting-action"
                :class="{ active: waitsOpen }"
                aria-label="查看听牌提示"
                :aria-expanded="waitsOpen"
                @click="waitsOpen = !waitsOpen"
              ><img class="action-icon" :src="`${imageBase}tips.png`" alt="" /></button>
              <template v-if="actionPrompt?.type === 'claim'">
                <button class="action primary" @click="userPeng"><b>碰</b></button>
                <button v-if="actionPrompt.canGang" class="action primary" @click="userGangFromDiscard"><b>杠</b></button>
                <button class="action pass" @click="userPass"><b>过</b></button>
              </template>
              <template v-else-if="actionPrompt?.type === 'rob'">
                <button class="action hu" @click="userHu"><b>胡</b></button>
                <button class="action pass" @click="userPass"><b>过</b></button>
              </template>
              <template v-else>
                <button v-if="userKongs.length" class="action primary" @click="userGang()"><b>杠</b></button>
                <button v-if="userCanHu" class="action hu" @click="userHu"><b>胡</b></button>
              </template>
          </div>
        </template>

        <section v-if="phase === 'lobby'" class="lobby">
          <p class="eyebrow">LINGNAN GUANGDONG MAHJONG</p>
          <h1>莲花<span>广麻</span></h1>
          <p class="subtitle"> </p>
          <div class="match-selector" role="radiogroup" aria-label="场次选择">
            <button :class="{ active: selectedMatch === 'east' }" role="radio" :aria-checked="selectedMatch === 'east'" @click="selectedMatch = 'east'"><b>东风场</b><span>东一局 — 东四局</span></button>
            <button :class="{ active: selectedMatch === 'hanchan' }" role="radio" :aria-checked="selectedMatch === 'hanchan'" @click="selectedMatch = 'hanchan'"><b>半庄场</b><span>东一局 — 南四局</span></button>
          </div>
          <button class="start-button" @click="startGameWithAudio"><b>开始{{ selectedMatch === 'east' ? '东风场' : '半庄场' }}</b><span>四人对局</span></button>
          <button class="text-button" @click="rulesOpen = true">游戏规则 →</button>
        </section>

        <Transition name="modal">
          <div v-if="result && resultVisible && !matchFinished" class="result-backdrop round-settlement">
            <section class="result-card settlement-card">
              <h2>{{ result.roundLabel }} · {{ result.draw ? '牌墙摸尽' : (result.robbedKong ? '抢杠胡' : '自摸') }}</h2>
              <div v-if="!result.draw" class="score-total"><span>总倍数</span><strong>×{{ result.multiplier }}</strong><em>+{{ result.totalWon ?? result.points * 3 }} 分</em></div>
              <div v-if="result.details?.length" class="score-details">
                <span v-for="detail in result.details" :key="detail.label">
                  {{ detail.label }} <b>{{ detail.points != null ? `+${detail.points} 分` : `×${detail.multiplier}` }}</b>
                </span>
              </div>
              <div v-if="result.horses?.length" class="horse-area">
                <div>
                  <MahjongTile
                    v-for="(tile, index) in result.horses"
                    :key="index"
                    :tile="tile"
                    :class="{ 'horse-hit': isHorse(tile) }"
                    small
                    disabled
                  />
                </div>
              </div>
              <div class="round-rankings">
                <article v-for="entry in result.scoreChanges" :key="entry.playerIndex" :class="{ winner: entry.playerIndex === result.winnerIndex }">
                  <strong class="rank-number">{{ entry.rank }}<small>位</small></strong>
                  <img :src="entry.avatar" :alt="`${entry.name}头像`" />
                  <span>{{ entry.name }}</span>
                  <em :class="{ positive: entry.delta > 0, negative: entry.delta < 0 }">{{ entry.delta > 0 ? '+' : '' }}{{ entry.delta }}</em>
                  <b>{{ entry.score }}</b>
                </article>
              </div>
              <div class="result-actions">
                <button class="secondary" @click="resultVisible = false">查看牌桌</button>
                <button @click="nextRound">继续</button>
              </div>
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
                  <img :src="entry.avatar" :alt="`${entry.name}头像`" />
                  <div class="final-name"><strong>{{ entry.name }}</strong><small v-if="entry.playerIndex === 0">你</small></div>
                  <em>{{ entry.score }}</em>
                </article>
              </div>
              <button @click="returnToLobby">返回大厅</button>
            </section>
          </div>
        </Transition>
        <button v-if="result && !resultVisible && !matchFinished" class="result-reopen" @click="resultVisible = true">查看结算</button>
        <aside v-if="winEffectLab" class="win-effect-lab" aria-label="胡牌特效测试面板">
          <strong>胡牌特效测试</strong>
          <div v-for="(seat, index) in winEffectLabSeats" :key="seat">
            <span>{{ seat }}</span>
            <button :data-testid="`win-self-${index}`" @click="debugPreviewWin(index)">自摸</button>
            <button :data-testid="`win-rob-${index}`" @click="debugPreviewWin(index, { robbedKong: true })">抢杠胡</button>
          </div>
        </aside>
      </div>
      <div v-if="players.length" class="base-score-badge">底分{{ BASE_SCORE }}分</div>
    </div>
    <RulesPanel :open="rulesOpen" @close="rulesOpen = false" />
  </main>
</template>
