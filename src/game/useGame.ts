import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { applyKongScore, applyWinScore, concealedKongs, canRobKong, drawHorses, isWinningHand, matchingCount, scoreHand, waitingTiles } from './rules'
import { createWall, shuffle, sortTiles, tileName, TILE_TYPES } from './tiles'
import type { EndGameOptions, GamePlayer, MatchType, ScoreDelta, ScoreFlowEvent, TableActionEvent, TableActionType, TileType, WinPresentation } from './types'
import {
  prefersReducedMotion,
  REDUCED_WIN_EFFECT_DURATION,
  REDUCED_WIN_REVEAL_DURATION,
  WIN_EFFECT_DURATION,
  WIN_EFFECT_SOUND_DELAY,
  WIN_REVEAL_DURATION,
} from './winEffect'

const AVATAR_BASE = `${import.meta.env.BASE_URL}avatars/`
const PLAYER_SEED = [
  { name: 'BestGuo2020', avatar: `${AVATAR_BASE}lotus.svg`, score: 1000 },
  { name: '南粤阿乐', avatar: `${AVATAR_BASE}ah-lok.svg`, score: 1000 },
  { name: '西关十三姨', avatar: `${AVATAR_BASE}shisan.svg`, score: 1000 },
  { name: '东山少爷', avatar: `${AVATAR_BASE}young-master.svg`, score: 1000 },
]

const MATCH_HANDS = { east: 4, hanchan: 8 }
const MATCH_NAMES = { east: '东风场', hanchan: '半庄场' }

interface UseGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
}

interface ActionPrompt {
  type: string
  tile: TileType
  from: number
  canGang?: boolean
  remainingClaims?: number[]
}

export function resolveWinTile(winner: GamePlayer, options: EndGameOptions = {}) {
  if (options.fourRed) return 'red' as const
  return options.winTile
    ?? winner.hand[winner.drawnTileIndex]
    ?? winner.hand[winner.hand.length - 1]
}

interface LastDiscard { tile: TileType; from: number; id: number }
interface Announcement { text: string; tone: string; id: number }
interface PendingKong { playerIndex: number; meldIndex: number; tile: TileType; remainingRobbers: number[] }
type RoundResult = Record<string, any>

export function advanceMatchState({ round, dealer, honba, matchType, result, playerCount = 4 }: {
  round: number; dealer: number; honba: number; matchType: MatchType; result: RoundResult; scores?: number[]; playerCount?: number
}) {
  const dealerKeepsSeat = !result.draw && result.winnerIndex === dealer
  const next = dealerKeepsSeat
    ? { round, dealer, honba: honba + 1 }
    : { round: round + 1, dealer: (dealer + 1) % playerCount, honba: 0 }
  return {
    ...next,
    finished: next.round > MATCH_HANDS[matchType],
  }
}

export function useGame({ playSound = () => {}, playSoundAndWait = async () => {} }: UseGameOptions = {}) {
  const phase = ref('lobby')
  const players = reactive<GamePlayer[]>([])
  const wall = ref<TileType[]>([])
  const currentPlayer = ref(-1)
  let kongDrawPlayerIndex = -1
  const selectedIndex = ref(-1)
  const turnSeconds = ref(12)
  const lastDiscard = ref<LastDiscard | null>(null)
  const actionPrompt = ref<ActionPrompt | null>(null)
  const pendingKong = ref<PendingKong | null>(null)
  const announcement = ref<Announcement | null>(null)
  const tableActionEvent = ref<TableActionEvent | null>(null)
  const scoreFlowEvent = ref<ScoreFlowEvent | null>(null)
  const result = ref<RoundResult | null>(null)
  const winEffect = ref<RoundResult | null>(null)
  const winPresentation = ref<WinPresentation | null>(null)
  const revealHands = ref(false)
  const winningPlayerIndex = ref(-1)
  const round = ref(1)
  const dealer = ref(0)
  const matchType = ref<MatchType>('east')
  const honba = ref(0)
  const matchFinished = ref(false)
  const dealAnimation = ref({ playerIndex: -1, count: 0, serial: 0 })
  const openingStage = ref(null)
  const diceValues = ref([1, 1])
  const userDrewThisTurn = ref(false)
  const timers = new Set<number>()
  let countdownHandle: number | null = null
  let openingSequence = 0

  const user = computed(() => players[0])
  const isUserTurn = computed(() => currentPlayer.value === 0 && phase.value === 'discard')
  const userCanHu = computed(() => Boolean(user.value)
    && isUserTurn.value
    && userDrewThisTurn.value
    && isWinningHand(user.value.hand, structuralMeldCount(user.value)))
  const userKongs = computed(() => {
    if (!user.value || !isUserTurn.value || !userDrewThisTurn.value) return []
    const concealed = concealedKongs(user.value.hand)
    const added = user.value.melds
      .filter((meld) => meld.type === 'peng' && user.value.hand.includes(meld.tile))
      .map((meld) => meld.tile)
    return [...new Set([...concealed, ...added])]
  })
  const wallCount = computed(() => wall.value.length)
  const windName = computed(() => (round.value > 4 ? '南' : '东'))
  const handNumber = computed(() => ((round.value - 1) % 4) + 1)
  const roundLabel = computed(() => `${windName.value}${handNumber.value}局`)
  const matchName = computed(() => MATCH_NAMES[matchType.value])
  const standings = computed(() => players
    .map((player, index) => ({ ...player, playerIndex: index }))
    .sort((a, b) => b.score - a.score || a.playerIndex - b.playerIndex)
    .map((player, index) => ({ ...player, rank: index + 1 })))
  function visibleRemainingCount(tile) {
    let visible = matchingCount(user.value?.hand ?? [], tile)
    players.forEach((player) => {
      visible += matchingCount(player.discards, tile)
      player.melds.forEach((meld) => {
        visible += matchingCount(meld.tiles ?? [], tile)
      })
    })
    return Math.max(0, 4 - visible)
  }
  function makeWaitInfo(waits, discard = null) {
    if (!waits.length) return null
    const tiles = waits.map((tile) => ({
      tile,
      // 只按玩家可见信息计算：自己手牌、弃牌与公开副露；不窥视对手暗手牌。
      remaining: visibleRemainingCount(tile),
    }))
    const allTiles = TILE_TYPES.filter((tile) => tile !== 'red')
    return {
      discard,
      tiles,
      any: waits.length === allTiles.length,
      remaining: tiles.reduce((total, item) => total + item.remaining, 0),
    }
  }
  function discardWaitInfo(handIndex) {
    const handAfterDiscard = user.value.hand.filter((_, index) => index !== handIndex)
    const waits = waitingTiles(handAfterDiscard, structuralMeldCount(user.value))
    return makeWaitInfo(waits, user.value.hand[handIndex])
  }
  const userCurrentWaits = computed(() => {
    if (!user.value || ['lobby', 'dealing', 'settled'].includes(phase.value)) return null
    return makeWaitInfo(waitingTiles(user.value.hand, structuralMeldCount(user.value)))
  })
  const userTingOptions = computed(() => {
    if (!user.value || !isUserTurn.value) return []
    const seen = new Set()
    return user.value.hand.flatMap((tile, index) => {
      if (seen.has(tile)) return []
      seen.add(tile)
      const info = discardWaitInfo(index)
      return info ? [info] : []
    })
  })
  const userDiscardWaits = computed(() => {
    if (selectedIndex.value < 0) return null
    const selectedTile = user.value?.hand[selectedIndex.value]
    return userTingOptions.value.find((option) => option.discard === selectedTile) ?? null
  })

  function structuralMeldCount(player: GamePlayer) {
    return player.melds.filter((meld) => meld.type !== 'flower').length
  }

  function later(callback: () => void, delay = 600) {
    const id = window.setTimeout(() => {
      timers.delete(id)
      callback()
    }, delay)
    timers.add(id)
    return id
  }

  function clearTimers() {
    openingSequence += 1
    timers.forEach((id) => window.clearTimeout(id))
    timers.clear()
    window.clearInterval(countdownHandle)
    countdownHandle = null
  }

  function announce(text, tone = 'gold') {
    announcement.value = { text, tone, id: Date.now() }
    later(() => {
      if (announcement.value?.text === text) announcement.value = null
    }, 1500)
  }

  function showTableAction(type: TableActionType, actorIndex: number, sourceIndex: number | null, tile: TileType, meldIndex: number) {
    const event: TableActionEvent = { id: Date.now(), type, actorIndex, sourceIndex, tile, meldIndex }
    tableActionEvent.value = event
    later(() => {
      if (tableActionEvent.value?.id === event.id) tableActionEvent.value = null
    }, 1050)
  }

  function showScoreFlow(deltas: ScoreDelta[]) {
    if (!deltas.length) return
    const event: ScoreFlowEvent = { id: Date.now(), deltas }
    scoreFlowEvent.value = event
    later(() => {
      if (scoreFlowEvent.value?.id === event.id) scoreFlowEvent.value = null
    }, 1050)
  }

  function resetPlayers() {
    const previousScores = players.map((player) => player.score)
    players.splice(0, players.length, ...PLAYER_SEED.map((player, index) => ({
      ...player,
      score: previousScores[index] ?? player.score,
      seat: index,
      hand: [],
      discards: [],
      melds: [],
      redCount: 0,
      drawnTileIndex: -1,
    })))
  }

  function takeTile(fromTail = false) {
    if (!wall.value.length) return null
    return fromTail ? wall.value.pop() : wall.value.shift()
  }

  function dealOne(player: GamePlayer) {
    const tile = takeTile(false)
    if (!tile) return
    receiveDealtTile(player, tile)
  }

  function receiveDealtTile(player: GamePlayer, tile) {
    if (tile === 'red') {
      player.redCount += 1
      player.melds.push({ type: 'flower', tile: 'red', tiles: ['red'] })
      const replacement = takeTile(true)
      if (replacement) receiveDealtTile(player, replacement)
    } else {
      player.hand.push(tile)
    }
  }

  function wait(delay: number): Promise<void> {
    return new Promise((resolve) => later(resolve, delay))
  }

  async function startGame(mode?: MatchType) {
    clearTimers()
    if (mode && MATCH_HANDS[mode]) {
      matchType.value = mode
      round.value = 1
      dealer.value = 0
      honba.value = 0
      matchFinished.value = false
      players.splice(0, players.length)
    }
    const sequence = openingSequence
    resetPlayers()
    wall.value = shuffle(createWall())
    result.value = null
    winEffect.value = null
    winPresentation.value = null
    revealHands.value = false
    winningPlayerIndex.value = -1
    actionPrompt.value = null
    pendingKong.value = null
    userDrewThisTurn.value = false
    selectedIndex.value = -1
    lastDiscard.value = null
    phase.value = 'dealing'
    dealAnimation.value = { playerIndex: -1, count: 0, serial: 0 }
    openingStage.value = 'start'

    await Promise.all([playSoundAndWait('game_start.mp3'), wait(1250)])
    if (sequence !== openingSequence) return
    diceValues.value = [
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1,
    ]
    openingStage.value = 'dice'
    await Promise.all([playSoundAndWait('dice.mp3'), wait(1150)])
    if (sequence !== openingSequence) return

    openingStage.value = 'deal'
    const seatOrder = players.map((_, offset) => (dealer.value + offset) % players.length)
    const dealBatch = async (playerIndex, count) => {
      if (count === 4) playSound('deal.mp3', 0.72)
      for (let tileIndex = 0; tileIndex < count; tileIndex += 1) dealOne(players[playerIndex])
      dealAnimation.value = {
        playerIndex,
        count,
        serial: dealAnimation.value.serial + 1,
      }
      await wait(count === 4 ? 260 : 150)
    }

    for (let batch = 0; batch < 3; batch += 1) {
      for (const playerIndex of seatOrder) {
        await dealBatch(playerIndex, 4)
        if (sequence !== openingSequence) return
      }
    }
    for (const playerIndex of seatOrder) {
      await dealBatch(playerIndex, 1)
      if (sequence !== openingSequence) return
    }
    phase.value = 'opening'
    openingStage.value = null
    dealAnimation.value = { playerIndex: -1, count: 0, serial: dealAnimation.value.serial + 1 }
    players.forEach((player) => { player.hand = sortTiles(player.hand) })
    const fourRedWinner = players.findIndex((player) => player.redCount >= 4)
    if (fourRedWinner >= 0) return endGame(fourRedWinner, { fourRed: true })
    announce(`${roundLabel.value} · 开牌`)
    later(() => beginTurn(dealer.value), 650)
  }

  function startCountdown() {
    window.clearInterval(countdownHandle)
    turnSeconds.value = 12
    countdownHandle = window.setInterval(() => {
      if (phase.value !== 'discard' || currentPlayer.value !== 0) return
      turnSeconds.value -= 1
      if (turnSeconds.value <= 0) {
        window.clearInterval(countdownHandle)
        selectedIndex.value = user.value.hand.length - 1
        userDiscard()
      }
    }, 1000)
  }

  function startPromptCountdown() {
    window.clearInterval(countdownHandle)
    turnSeconds.value = 12
    const prompt = actionPrompt.value
    countdownHandle = window.setInterval(() => {
      if (phase.value !== 'prompt' || actionPrompt.value !== prompt) {
        window.clearInterval(countdownHandle)
        countdownHandle = null
        return
      }
      turnSeconds.value -= 1
      if (turnSeconds.value <= 0) {
        window.clearInterval(countdownHandle)
        countdownHandle = null
        userPass()
      }
    }, 1000)
  }

  async function drawFor(playerIndex, fromTail = false) {
    const player = players[playerIndex]
    kongDrawPlayerIndex = fromTail ? playerIndex : -1
    const tile = takeTile(fromTail)
    if (!tile) {
      endDraw()
      return false
    }
    if (tile === 'red') {
      player.redCount += 1
      player.melds.push({ type: 'flower', tile: 'red', tiles: ['red'] })
      showTableAction('flower-gang', playerIndex, null, tile, player.melds.length - 1)
      if (player.redCount >= 4) {
        endGame(playerIndex, { fourRed: true })
        return false
      }
      // 红中先完成亮杠与报杠音效，再从牌墙尾补摸，避免两个动画挤在一起。
      await playSoundAndWait('gang.mp3')
      if (phase.value === 'settled') return false
      return drawFor(playerIndex, true)
    }
    // 保留刚摸到的牌在最右端，出牌前不要混入已整理的手牌。
    player.hand = [...player.hand, tile]
    player.drawnTileIndex = player.hand.length - 1
    playSound('give.mp3', 0.7)
    return true
  }

  async function beginTurn(playerIndex: number, options: { skipDraw?: boolean; fromTail?: boolean } = {}) {
    if (phase.value === 'settled') return
    if (!wall.value.length) return endDraw()
    currentPlayer.value = playerIndex
    userDrewThisTurn.value = false
    phase.value = 'drawing'
    selectedIndex.value = -1
    actionPrompt.value = null
    if (options.skipDraw) kongDrawPlayerIndex = -1
    const drawn = options.skipDraw ? true : await drawFor(playerIndex, options.fromTail)
    if (!drawn || phase.value === 'settled') return

    if (playerIndex === 0) {
      userDrewThisTurn.value = !options.skipDraw
      phase.value = 'discard'
      startCountdown()
      return
    }
    phase.value = 'thinking'
    later(() => playAI(playerIndex), 650)
  }

  function chooseAIDiscard(player) {
    const scored = player.hand.map((tile, index) => {
      const same = matchingCount(player.hand, tile) - 1
      const suitMatch = /^([mps])([1-9])$/.exec(tile)
      let neighbors = 0
      if (suitMatch) {
        const number = Number(suitMatch[2])
        neighbors += player.hand.includes(`${suitMatch[1]}${number - 1}`) ? 1 : 0
        neighbors += player.hand.includes(`${suitMatch[1]}${number + 1}`) ? 1 : 0
      }
      const penalty = tile === 'white' ? 10 : 0
      return { index, score: same * 4 + neighbors * 2 + penalty + Math.random() }
    })
    scored.sort((a, b) => a.score - b.score)
    return scored[0]?.index ?? 0
  }

  async function playAI(playerIndex) {
    if (phase.value === 'settled' || currentPlayer.value !== playerIndex) return
    const player = players[playerIndex]
    if (isWinningHand(player.hand, structuralMeldCount(player))) {
      return endGame(playerIndex, { kongBloom: kongDrawPlayerIndex === playerIndex })
    }

    const added = player.melds.findIndex((meld) => meld.type === 'peng' && player.hand.includes(meld.tile))
    if (added >= 0) {
      const tile = player.melds[added].tile
      return requestAddedKong(playerIndex, added, tile)
    }

    const concealed = concealedKongs(player.hand)
    if (concealed.length) {
      await performConcealedKong(playerIndex, concealed[0])
      if (phase.value === 'settled') return
      return later(() => playAI(playerIndex), 550)
    }

    discardTile(playerIndex, chooseAIDiscard(player))
  }

  function discardTile(playerIndex, handIndex) {
    const player = players[playerIndex]
    const [tile] = player.hand.splice(handIndex, 1)
    if (!tile) return
    player.hand = sortTiles(player.hand)
    player.drawnTileIndex = -1
    kongDrawPlayerIndex = -1
    player.discards.push(tile)
    if (playerIndex === 0) userDrewThisTurn.value = false
    lastDiscard.value = { tile, from: playerIndex, id: Date.now() }
    playSound('dapai.mp3', 0.8)
    later(() => playSound(tileAudioFile(tile)), 80)
    phase.value = 'checking'
    window.clearInterval(countdownHandle)

    const claimants = findClaims(playerIndex, tile)
    if (claimants.length) return offerNextClaim(claimants, tile, playerIndex)
    later(() => beginTurn((playerIndex + 1) % 4), 450)
  }

  function seatDistance(from, to) {
    return (to - from + players.length) % players.length
  }

  function tileAudioFile(tile) {
    const suited = /^([mps])([1-9])$/.exec(tile)
    if (suited) return `${suited[2]}${suited[1]}.mp3`
    const honorIndex = { east: 1, south: 2, west: 3, north: 4, red: 5, green: 6, white: 7 }
    return honorIndex[tile] ? `${honorIndex[tile]}z.mp3` : null
  }

  function findClaims(from, tile) {
    if (tile === 'white' || tile === 'red') return []
    return players
      .map((player, playerIndex) => ({
        playerIndex,
        count: matchingCount(player.hand, tile),
        distance: seatDistance(from, playerIndex),
      }))
      .filter(({ playerIndex, count }) => playerIndex !== from && count >= 2)
      .sort((a, b) => a.distance - b.distance)
      .map(({ playerIndex, count }) => ({ playerIndex, canGang: count >= 3 }))
  }

  function offerNextClaim(claimants, tile, from) {
    const [claimant, ...remainingClaims] = claimants
    if (!claimant) return later(() => beginTurn((from + 1) % 4), 450)
    if (claimant.playerIndex === 0) {
      actionPrompt.value = {
        type: 'claim', tile, from, canGang: claimant.canGang, remainingClaims,
      }
      phase.value = 'prompt'
      startPromptCountdown()
    } else {
      later(() => aiClaim(claimant.playerIndex, tile), 500)
    }
  }

  function removeMatches(hand, tile, amount) {
    const next = [...hand]
    for (let count = 0; count < amount; count += 1) next.splice(next.indexOf(tile), 1)
    return next
  }

  function removeLastDiscard(from, tile) {
    const pile = players[from].discards
    if (pile[pile.length - 1] === tile) pile.pop()
  }

  async function aiClaim(playerIndex, tile) {
    if (phase.value === 'settled') return
    const player = players[playerIndex]
    player.drawnTileIndex = -1
    const from = lastDiscard.value.from
    const isGang = matchingCount(player.hand, tile) >= 3
    removeLastDiscard(from, tile)
    if (isGang) {
      player.hand = removeMatches(player.hand, tile, 3)
      player.melds.push({ type: 'gang', tile, from, tiles: [tile, tile, tile, tile] })
      const scoreDeltas = applyKongScore(players, playerIndex, 'discard', from)
      showTableAction('discard-gang', playerIndex, from, tile, player.melds.length - 1)
      showScoreFlow(scoreDeltas)
      playSound('gang.mp3')
      currentPlayer.value = playerIndex
      if (await drawFor(playerIndex, true)) later(() => playAI(playerIndex), 550)
    } else {
      player.hand = removeMatches(player.hand, tile, 2)
      player.melds.push({ type: 'peng', tile, from, tiles: [tile, tile, tile] })
      showTableAction('peng', playerIndex, from, tile, player.melds.length - 1)
      playSound('peng.mp3')
      currentPlayer.value = playerIndex
      phase.value = 'thinking'
      later(() => discardTile(playerIndex, chooseAIDiscard(player)), 650)
    }
  }

  function selectTile(index) {
    if (!isUserTurn.value) return
    if (selectedIndex.value === index) return userDiscard()
    selectedIndex.value = index
    playSound('click.mp3', 0.65)
  }

  function userDiscard() {
    if (!isUserTurn.value || selectedIndex.value < 0) return
    const index = selectedIndex.value
    selectedIndex.value = -1
    discardTile(0, index)
  }

  function userPass() {
    const prompt = actionPrompt.value
    window.clearInterval(countdownHandle)
    countdownHandle = null
    actionPrompt.value = null
    if (!prompt) return
    playSound('click.mp3', 0.65)
    if (prompt.type === 'rob') {
      const kong = pendingKong.value
      if (!kong) return
      const nextRobber = kong.remainingRobbers?.[0]
      if (nextRobber !== undefined) {
        pendingKong.value = null
        announce(`${players[nextRobber].name} 抢杠胡`, 'red')
        return later(() => endGame(nextRobber, { robbedKong: true, robbedKongPlayerIndex: kong.playerIndex, winTile: kong.tile }), 450)
      }
      pendingKong.value = null
      return settleAddedKong(kong.playerIndex)
    }
    offerNextClaim(prompt.remainingClaims ?? [], prompt.tile, prompt.from)
  }

  function userPeng() {
    const prompt = actionPrompt.value
    if (prompt?.type !== 'claim') return
    window.clearInterval(countdownHandle)
    countdownHandle = null
    removeLastDiscard(prompt.from, prompt.tile)
    user.value.hand = removeMatches(user.value.hand, prompt.tile, 2)
    user.value.drawnTileIndex = -1
    user.value.melds.push({ type: 'peng', tile: prompt.tile, from: prompt.from, tiles: [prompt.tile, prompt.tile, prompt.tile] })
    actionPrompt.value = null
    currentPlayer.value = 0
    userDrewThisTurn.value = false
    phase.value = 'discard'
    selectedIndex.value = -1
    startCountdown()
    showTableAction('peng', 0, prompt.from, prompt.tile, user.value.melds.length - 1)
    playSound('peng.mp3')
  }

  function userGangFromDiscard() {
    const prompt = actionPrompt.value
    if (prompt?.type !== 'claim' || !prompt.canGang) return
    window.clearInterval(countdownHandle)
    countdownHandle = null
    removeLastDiscard(prompt.from, prompt.tile)
    user.value.hand = removeMatches(user.value.hand, prompt.tile, 3)
    user.value.drawnTileIndex = -1
    user.value.melds.push({ type: 'gang', tile: prompt.tile, from: prompt.from, tiles: Array(4).fill(prompt.tile) })
    const scoreDeltas = applyKongScore(players, 0, 'discard', prompt.from)
    actionPrompt.value = null
    currentPlayer.value = 0
    userDrewThisTurn.value = false
    showTableAction('discard-gang', 0, prompt.from, prompt.tile, user.value.melds.length - 1)
    showScoreFlow(scoreDeltas)
    playSound('gang.mp3')
    later(() => beginTurn(0, { fromTail: true }), 350)
  }

  async function performConcealedKong(playerIndex, tile) {
    const player = players[playerIndex]
    player.hand = removeMatches(player.hand, tile, 4)
    player.drawnTileIndex = -1
    player.melds.push({ type: 'angang', tile, tiles: [tile, tile, tile, tile] })
    const scoreDeltas = applyKongScore(players, playerIndex, 'concealed')
    showTableAction('concealed-gang', playerIndex, null, tile, player.melds.length - 1)
    showScoreFlow(scoreDeltas)
    playSound('gang.mp3')
    if (playerIndex === 0) later(() => beginTurn(0, { fromTail: true }), 350)
    else if (await drawFor(playerIndex, true)) phase.value = 'thinking'
  }

  function declareAddedKong(playerIndex, meldIndex, tile) {
    const player = players[playerIndex]
    player.hand = removeMatches(player.hand, tile, 1)
    player.drawnTileIndex = -1
    player.melds[meldIndex] = {
      ...player.melds[meldIndex],
      type: 'gang',
      added: true,
      pending: true,
      tile,
      tiles: [tile, tile, tile, tile],
    }
    phase.value = 'kong'
    showTableAction('added-gang', playerIndex, null, tile, meldIndex)
    playSound('gang.mp3')
  }

  async function settleAddedKong(playerIndex) {
    const player = players[playerIndex]
    const meld = player.melds.find((item) => item.type === 'gang' && item.added && item.pending)
    if (meld) meld.pending = false
    const scoreDeltas = applyKongScore(players, playerIndex, 'added')
    showScoreFlow(scoreDeltas)
    if (playerIndex === 0) later(() => beginTurn(0, { fromTail: true }), 350)
    else if (await drawFor(playerIndex, true)) later(() => playAI(playerIndex), 500)
  }

  function findRobbers(kongPlayerIndex, tile) {
    return players
      .map((player, playerIndex) => ({
        playerIndex,
        distance: seatDistance(kongPlayerIndex, playerIndex),
        canRob: playerIndex !== kongPlayerIndex
          && canRobKong(player.hand, tile, structuralMeldCount(player)),
      }))
      .filter(({ canRob }) => canRob)
      .sort((a, b) => a.distance - b.distance)
      .map(({ playerIndex }) => playerIndex)
  }

  function requestAddedKong(playerIndex, meldIndex, tile) {
    const [robberIndex, ...remainingRobbers] = findRobbers(playerIndex, tile)
    declareAddedKong(playerIndex, meldIndex, tile)
    if (robberIndex === undefined) return later(() => settleAddedKong(playerIndex), 650)

    pendingKong.value = { playerIndex, meldIndex, tile, remainingRobbers }
    later(() => offerRobKong(robberIndex), 650)
  }

  function offerRobKong(robberIndex) {
    const kong = pendingKong.value
    if (!kong || phase.value === 'settled') return
    if (robberIndex === 0) {
      actionPrompt.value = { type: 'rob', tile: kong.tile, from: kong.playerIndex }
      phase.value = 'prompt'
      announce('可抢杠胡', 'red')
      startPromptCountdown()
      return
    }

    announce(`${players[robberIndex].name} 抢杠胡`, 'red')
    pendingKong.value = null
    later(() => endGame(robberIndex, { robbedKong: true, robbedKongPlayerIndex: kong.playerIndex, winTile: kong.tile }), 450)
  }

  function userGang(tile = userKongs.value[0]) {
    if (!tile || !isUserTurn.value) return
    userDrewThisTurn.value = false
    window.clearInterval(countdownHandle)
    const meldIndex = user.value.melds.findIndex((meld) => meld.type === 'peng' && meld.tile === tile)
    if (meldIndex >= 0) requestAddedKong(0, meldIndex, tile)
    else {
      performConcealedKong(0, tile)
    }
  }

  function userHu() {
    if (actionPrompt.value?.type === 'rob') {
      const kongPlayerIndex = pendingKong.value?.playerIndex ?? actionPrompt.value.from
      pendingKong.value = null
      return endGame(0, {
        robbedKong: true,
        robbedKongPlayerIndex: kongPlayerIndex,
        winTile: actionPrompt.value?.tile,
      })
    }
    if (userCanHu.value) endGame(0, { kongBloom: kongDrawPlayerIndex === 0 })
  }

  function takeRobbedKongTile(playerIndex, tile) {
    const player = players[playerIndex]
    const meldIndex = player?.melds.findIndex((meld) => (
      meld.type === 'gang' && meld.added && meld.pending && meld.tile === tile
    )) ?? -1
    if (meldIndex < 0) return -1
    const { added, pending, ...meld } = player.melds[meldIndex]
    player.melds[meldIndex] = {
      ...meld,
      type: 'peng',
      tiles: meld.tiles.slice(0, 3),
    }
    return meldIndex
  }

  function endGame(winnerIndex: number, options: EndGameOptions = {}) {
    if (['win-effect', 'revealing', 'settled', 'finished'].includes(phase.value)) return
    clearTimers()
    phase.value = 'win-effect'
    openingStage.value = null
    currentPlayer.value = -1
    userDrewThisTurn.value = false
    actionPrompt.value = null
    pendingKong.value = null
    const winner = players[winnerIndex]
    winningPlayerIndex.value = winnerIndex
    // 四红中在摸到时已经亮到花杠区，不在暗手里；胡牌展示必须使用这张红中，
    // 不能回退到此前摸到的牌或手牌末张。
    const winTile = resolveWinTile(winner, options)
    const robbedKongMeldIndex = options.robbedKong
      ? takeRobbedKongTile(options.robbedKongPlayerIndex, winTile)
      : -1
    const sourceIndex = options.robbedKong || options.fourRed
      ? -1
      : (winner.drawnTileIndex >= 0 ? winner.drawnTileIndex : winner.hand.lastIndexOf(winTile))
    winPresentation.value = {
      winnerIndex,
      tile: winTile,
      sourceIndex,
      robbedKong: Boolean(options.robbedKong),
      robbedKongPlayerIndex: options.robbedKongPlayerIndex ?? -1,
      robbedKongMeldIndex,
    }
    const reducedMotion = prefersReducedMotion()
    const effectDuration = reducedMotion ? REDUCED_WIN_EFFECT_DURATION : WIN_EFFECT_DURATION
    const revealDuration = reducedMotion ? REDUCED_WIN_REVEAL_DURATION : WIN_REVEAL_DURATION
    winEffect.value = {
      winnerIndex,
      tile: winTile,
      robbedKong: Boolean(options.robbedKong),
      robbedKongPlayerIndex: options.robbedKongPlayerIndex ?? -1,
      robbedKongMeldIndex,
      duration: effectDuration,
      reducedMotion,
      id: Date.now(),
    }
    showTableAction(
      options.robbedKong ? 'robbed-kong-win' : 'self-draw',
      winnerIndex,
      options.robbedKong ? (options.robbedKongPlayerIndex ?? null) : null,
      winTile,
      -1,
    )
    playSound(options.robbedKong ? 'hu.mp3' : 'zimo.mp3')
    if (!reducedMotion) later(() => playSound('hu_effect_sound.mp3', 0.72), WIN_EFFECT_SOUND_DELAY)
    announcement.value = null
    later(() => {
      winEffect.value = null
      revealHands.value = true
      phase.value = 'revealing'
      later(() => finalizeWin(winnerIndex, options), revealDuration)
    }, effectDuration)
  }

  function finalizeWin(winnerIndex: number, options: EndGameOptions) {
    const winner = players[winnerIndex]
    const scoresBefore = players.map((player) => player.score)
    const { horses, hits } = drawHorses(wall.value, 8)
    const score = scoreHand({
      dealer: winnerIndex === dealer.value,
      noJoker: !winner.hand.includes('white'),
      fourRed: Boolean(options.fourRed),
      kongBloom: Boolean(options.kongBloom),
      horseHits: hits,
      robbedKong: Boolean(options.robbedKong),
    })
    const totalWon = applyWinScore(
      players,
      winnerIndex,
      score.points,
      options.robbedKong ? options.robbedKongPlayerIndex : null,
      dealer.value,
    )
    result.value = makeRoundResult({ winnerIndex, winner: winner.name, horses, hits, ...score, totalWon, ...options }, scoresBefore)
    phase.value = 'settled'
  }

  function debugPreviewWin(winnerIndex = 0, { robbedKong = false } = {}) {
    if (!import.meta.env.DEV) return
    clearTimers()
    if (players.length !== 4) resetPlayers()
    const baseHand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east']
    players.forEach((player, index) => {
      const hand = [...baseHand]
      if (index === winnerIndex && !robbedKong) hand.push('east')
      player.hand.splice(0, player.hand.length, ...hand)
      player.discards.splice(0)
      player.melds.splice(0)
      player.score = 1000
      player.drawnTileIndex = index === winnerIndex && !robbedKong ? hand.length - 1 : -1
    })
    const robbedKongPlayerIndex = robbedKong ? (winnerIndex + 3) % 4 : -1
    if (robbedKong) {
      players[robbedKongPlayerIndex].melds.push({
        type: 'gang',
        added: true,
        pending: true,
        tile: 'east',
        from: (robbedKongPlayerIndex + 1) % 4,
        tiles: ['east', 'east', 'east', 'east'],
      })
    }
    wall.value = shuffle(createWall())
    lastDiscard.value = null
    result.value = null
    winEffect.value = null
    winPresentation.value = null
    revealHands.value = false
    winningPlayerIndex.value = -1
    matchFinished.value = false
    phase.value = 'discard'
    endGame(winnerIndex, {
      robbedKong,
      robbedKongPlayerIndex,
      winTile: 'east',
    })
  }

  function endDraw() {
    clearTimers()
    phase.value = 'settled'
    openingStage.value = null
    currentPlayer.value = -1
    userDrewThisTurn.value = false
    actionPrompt.value = null
    winEffect.value = null
    winPresentation.value = null
    revealHands.value = true
    winningPlayerIndex.value = -1
    const scoresBefore = players.map((player) => player.score)
    result.value = makeRoundResult({ draw: true, winner: '荒庄', horses: [], hits: 0, multiplier: 0, points: 0, details: [] }, scoresBefore)
  }

  function makeRoundResult(base, scoresBefore) {
    const ranking = players
      .map((player, playerIndex) => ({ playerIndex, score: player.score }))
      .sort((a, b) => b.score - a.score || a.playerIndex - b.playerIndex)
    const ranks = new Map(ranking.map((item, index) => [item.playerIndex, index + 1]))
    return {
      ...base,
      roundLabel: roundLabel.value,
      honba: honba.value,
      scoreChanges: players.map((player, playerIndex) => ({
        playerIndex,
        name: player.name,
        avatar: player.avatar,
        score: player.score,
        delta: player.score - scoresBefore[playerIndex],
        rank: ranks.get(playerIndex),
      })),
    }
  }

  function nextRound() {
    if (!result.value || matchFinished.value) return
    const next = advanceMatchState({
      round: round.value,
      dealer: dealer.value,
      honba: honba.value,
      matchType: matchType.value,
      result: result.value,
      playerCount: players.length,
    })
    round.value = next.round
    dealer.value = next.dealer
    honba.value = next.honba
    if (next.finished) {
      matchFinished.value = true
      phase.value = 'finished'
      return
    }
    startGame()
  }

  function returnToLobby() {
    clearTimers()
    phase.value = 'lobby'
    result.value = null
    winEffect.value = null
    winPresentation.value = null
    revealHands.value = false
    winningPlayerIndex.value = -1
    matchFinished.value = false
    players.splice(0, players.length)
  }

  onBeforeUnmount(clearTimers)

  return {
    phase, players, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
    actionPrompt, announcement, tableActionEvent, scoreFlowEvent, result, winEffect, winPresentation, revealHands, winningPlayerIndex,
    round, dealer, user, isUserTurn, userCanHu,
    matchType, matchName, matchFinished, honba, roundLabel, standings,
    dealAnimation, openingStage, diceValues, userCurrentWaits, userTingOptions, userDiscardWaits,
    userKongs, startGame, selectTile, userDiscard, userPass, userPeng, userGangFromDiscard,
    userGang, userHu, nextRound, returnToLobby, tileName, debugPreviewWin,
  }
}
