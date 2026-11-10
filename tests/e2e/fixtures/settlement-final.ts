import { createApp, h, ref } from 'vue'
import SettlementOverlay from '../../../src/components/settlement/SettlementOverlay.vue'
import type { RoundResult } from '../../../src/game/core/contracts/gamePort'
import type { GamePlayer } from '../../../src/game/core/contracts/types'
import { defaultAvatarForSeat } from '../../../src/game/core/presentation/avatar'
import '../../../src/style.css'

const remote = new URLSearchParams(location.search).has('remote')
const standings = [0, 1, 2, 3].map(seat => ({
  seat, name: `玩家${seat + 1}`, avatar: defaultAvatarForSeat(seat), score: 1300 - seat * 200,
  hand: [], melds: [], discards: [], redCount: 0, drawnTileIndex: -1, playerIndex: seat, rank: seat + 1,
})) satisfies Array<GamePlayer & { playerIndex: number; rank: number }>
const result = ref<RoundResult | null>({
  roundLabel: '东4局', winnerIndex: 0, winType: remote ? 'discard' : 'self-draw',
  details: [{ label: remote ? '平胡' : '中马', multiplier: 1 }],
  scoreChanges: standings.map((player, index) => ({ ...player, delta: index === 0 ? 300 : -100 })),
  ...(remote ? {} : { horses: ['m1', 'm2'] }),
})
const dealer = ref(0)
const matchFinished = ref(false)
const resultVisible = ref(true)

function finishMatch() {
  dealer.value = 1
  matchFinished.value = true
  if (remote) result.value = null
}

Object.assign(window, { finishSettlementFixture: finishMatch })
createApp({
  render: () => h('main', { class: 'game-app', 'data-table-theme': 'jade' }, [
    h(SettlementOverlay, {
      result: result.value, resultVisible: resultVisible.value, matchFinished: matchFinished.value,
      dealer: dealer.value, lastRound: true, waitingNextRound: false, continueCountdown: 0,
      gameMode: remote ? 'remote' : 'local', matchName: '东风场', standings, playerId: '',
      'onUpdate:resultVisible': visible => { resultVisible.value = visible },
      onNextRound: finishMatch,
    }),
  ]),
}).mount('#app')
