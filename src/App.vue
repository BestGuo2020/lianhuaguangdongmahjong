<script setup>
import { ref, watch } from 'vue'
import MahjongTile from './components/MahjongTile.vue'
import MahjongTable3D from './components/MahjongTable3D.vue'
import PlayerSeat from './components/PlayerSeat.vue'
import RulesPanel from './components/RulesPanel.vue'
import { isHorse } from './game/tiles'
import { useGame } from './game/useGame'

const rulesOpen = ref(false)
const soundOn = ref(true)
const resultVisible = ref(true)

const {
  phase, players, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
  actionPrompt, announcement, result, round, dealer, user, isUserTurn, userCanHu,
  userKongs, startGame, selectTile, userDiscard, userPass, userPeng, userGangFromDiscard,
  userGang, userHu, nextRound,
} = useGame()

const seatPosition = ['bottom', 'right', 'top', 'left']

watch(result, (value) => {
  resultVisible.value = Boolean(value)
})
</script>

<template>
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

          <section class="user-area">
            <div class="user-identity" :class="{ active: currentPlayer === 0 }">
              <span v-if="dealer === 0" class="dealer-badge">庄</span>
              <div class="avatar">莲</div>
              <div><strong>{{ user.name }}</strong><span>{{ user.score }}</span></div>
            </div>
            <div class="hand-rack" :class="{ playable: isUserTurn, 'has-melds': user.melds.length }">
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

          <div v-if="isUserTurn" class="turn-timer"><span>{{ turnSeconds }}</span><small>秒</small></div>

          <Transition name="actions">
            <div v-if="actionPrompt || isUserTurn" class="action-bar">
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
          </Transition>
        </template>

        <section v-if="phase === 'lobby'" class="lobby">
          <div class="lotus-mark"><span>莲</span></div>
          <p class="eyebrow">LINGNAN MAHJONG CLUB</p>
          <h1>莲花<span>广麻</span></h1>
          <p class="subtitle">一桌岭南风雅 · 一局人情冷暖</p>
          <div class="lobby-rules"><span>白板癞子</span><i></i><span>红中开杠</span><i></i><span>自摸买马</span></div>
          <button class="start-button" @click="startGame"><b>开始对局</b><span>四人单机 · 即开即玩</span></button>
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
