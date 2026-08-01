<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import MahjongTile from './components/MahjongTile.vue'
import MahjongTable3D from './components/MahjongTable3D.vue'
import PlayerSeat from './components/PlayerSeat.vue'
import RulesPanel from './components/RulesPanel.vue'
import { isHorse } from './game/tiles'
import { useGame } from './game/useGame'
import { useAudio } from './game/useAudio'

const rulesOpen = ref(false)
const resultVisible = ref(true)
const waitsOpen = ref(false)
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

    if (screen.orientation?.lock) {
      await screen.orientation.lock('landscape')
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
  actionPrompt, announcement, result, round, dealer, user, isUserTurn, userCanHu,
  userKongs, userCurrentWaits, userTingOptions, userDiscardWaits, dealAnimation, openingStage, diceValues, startGame, selectTile, userDiscard, userPass, userPeng, userGangFromDiscard,
  userGang, userHu, nextRound,
} = useGame({ playSound: playEffect, playSoundAndWait: playEffectAndWait })

function startGameWithAudio() {
  startBgm()
  startGame()
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
          <div class="brand-mini"><i>莲</i><span>莲花广麻</span></div>
          <div class="round-info">东风局 · 第 {{ round }} 局</div>
          <nav>
            <button :aria-label="soundOn ? '关闭声音' : '开启声音'" @click="soundOn = !soundOn">{{ soundOn ? '◖))' : '◖×' }}</button>
            <button aria-label="查看规则" @click="rulesOpen = true">规</button>
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
            :reveal-hands="Boolean(result)"
            :deal-animation="dealAnimation"
            :opening-stage="openingStage"
            :dice-values="diceValues"
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
              <span>东风局 · 第 {{ round }} 局</span>
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
                v-for="(tile, index) in user.hand"
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
              ><b>💡</b><span>听牌</span></button>
              <template v-if="actionPrompt?.type === 'claim'">
                <button class="action primary" @click="userPeng"><b>碰</b><span>{{ actionPrompt.tile }}</span></button>
                <button v-if="actionPrompt.canGang" class="action primary" @click="userGangFromDiscard"><b>杠</b><span>尾牌补摸</span></button>
                <button class="action pass" @click="userPass"><b>过</b></button>
              </template>
              <template v-else-if="actionPrompt?.type === 'rob'">
                <button class="action hu" @click="userHu"><b>胡</b><span>抢杠胡</span></button>
                <button class="action pass" @click="userPass"><b>过</b></button>
              </template>
              <template v-else>
                <button v-if="userKongs.length" class="action primary" @click="userGang()"><b>杠</b><span>尾牌补摸</span></button>
                <button v-if="userCanHu" class="action hu" @click="userHu"><b>胡</b><span>自摸</span></button>
                <button class="action discard-action" :disabled="selectedIndex < 0" @click="userDiscard"><b>出牌</b></button>
              </template>
          </div>
        </template>

        <section v-if="phase === 'lobby'" class="lobby">
          <div class="lotus-mark"><span>莲</span></div>
          <p class="eyebrow">LINGNAN MAHJONG CLUB</p>
          <h1>莲花<span>广麻</span></h1>
          <p class="subtitle">一桌岭南风雅 · 一局人情冷暖</p>
          <div class="lobby-rules"><span>白板癞子</span><i></i><span>红中开杠</span><i></i><span>自摸买马</span></div>
          <button class="start-button" @click="startGameWithAudio"><b>开始对局</b><span>四人单机 · 即开即玩</span></button>
          <button class="text-button" @click="rulesOpen = true">先看玩法说明 →</button>
        </section>

        <Transition name="modal">
          <div v-if="result && resultVisible" class="result-backdrop">
            <section class="result-card">
              <div class="result-seal">{{ result.draw ? '和' : '胡' }}</div>
              <p>{{ result.draw ? '牌墙摸尽' : (result.robbedKong ? '抢杠胡' : '自摸胡牌') }}</p>
              <h2>{{ result.winner }}</h2>
              <div v-if="!result.draw" class="score-total"><span>总倍数</span><strong>×{{ result.multiplier }}</strong><em>+{{ result.points * 3 }} 分</em></div>
              <div v-if="result.details?.length" class="score-details">
                <span v-for="detail in result.details" :key="detail.label">{{ detail.label }} <b>×{{ detail.multiplier }}</b></span>
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
              <div class="result-actions">
                <button class="secondary" @click="resultVisible = false">查看牌桌</button>
                <button @click="nextRound">再来一局</button>
              </div>
            </section>
          </div>
        </Transition>
        <button v-if="result && !resultVisible" class="result-reopen" @click="resultVisible = true">查看结算</button>
      </div>
    </div>
    <RulesPanel :open="rulesOpen" @close="rulesOpen = false" />
  </main>
</template>
