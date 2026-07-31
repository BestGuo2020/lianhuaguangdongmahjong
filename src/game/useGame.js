import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { concealedKongs, canRobKong, drawHorses, isWinningHand, matchingCount, scoreHand } from './rules'
import { createWall, shuffle, sortTiles, tileName, TILE_TYPES } from './tiles'

const PLAYER_SEED = [
  { name: '莲花', avatar: '莲', score: 1000 },
  { name: '南粤阿乐', avatar: '乐', score: 1000 },
  { name: '西关十三姨', avatar: '姨', score: 1000 },
  { name: '东山少爷', avatar: '少', score: 1000 },
]

export function useGame() {
  const phase = ref('lobby')
  const players = reactive([])
  const wall = ref([])
  const currentPlayer = ref(-1)
  const selectedIndex = ref(-1)
  const turnSeconds = ref(12)
  const lastDiscard = ref(null)
  const actionPrompt = ref(null)
  const pendingKong = ref(null)
  const announcement = ref(null)
  const result = ref(null)
  const round = ref(1)
  const dealer = ref(0)
  const timers = new Set()
  let countdownHandle = null

  const user = computed(() => players[0])
  const isUserTurn = computed(() => currentPlayer.value === 0 && phase.value === 'discard')
  const userCanHu = computed(() => Boolean(user.value) && isUserTurn.value && isWinningHand(user.value.hand, structuralMeldCount(user.value)))
  const userKongs = computed(() => {
    if (!user.value || !isUserTurn.value) return []
    const concealed = concealedKongs(user.value.hand)
    const added = user.value.melds
      .filter((meld) => meld.type === 'peng' && user.value.hand.includes(meld.tile))
      .map((meld) => meld.tile)
    return [...new Set([...concealed, ...added])]
  })
  const wallCount = computed(() => wall.value.length)

  function structuralMeldCount(player) {
    return player.melds.filter((meld) => meld.type !== 'flower').length
  }

  function later(callback, delay = 600) {
    const id = window.setTimeout(() => {
      timers.delete(id)
      callback()
    }, delay)
    timers.add(id)
    return id
  }

  function clearTimers() {
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

  function resetPlayers() {
    players.splice(0, players.length, ...PLAYER_SEED.map((player, index) => ({
      ...player,
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

  function dealOne(player) {
    const tile = takeTile(false)
    if (!tile) return
    if (tile === 'red') {
      player.redCount += 1
      player.melds.push({ type: 'flower', tile: 'red', tiles: ['red'] })
      const replacement = takeTile(true)
      if (replacement === 'red') {
        wall.value.push(replacement)
        return dealOne(player)
      }
      if (replacement) player.hand.push(replacement)
    } else {
      player.hand.push(tile)
    }
  }

  function startGame() {
    clearTimers()
    resetPlayers()
    wall.value = shuffle(createWall())
    result.value = null
    actionPrompt.value = null
    pendingKong.value = null
    selectedIndex.value = -1
    lastDiscard.value = null
    phase.value = 'dealing'

    for (let draw = 0; draw < 13; draw += 1) players.forEach(dealOne)
    players.forEach((player) => { player.hand = sortTiles(player.hand) })
    const fourRedWinner = players.findIndex((player) => player.redCount >= 4)
    if (fourRedWinner >= 0) return endGame(fourRedWinner, { fourRed: true })
    announce('东风局 · 开牌')
    later(() => beginTurn(dealer.value), 900)
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

  function drawFor(playerIndex, fromTail = false) {
    const player = players[playerIndex]
    const tile = takeTile(fromTail)
    if (!tile) {
      endDraw()
      return false
    }
    if (tile === 'red') {
      player.redCount += 1
      player.melds.push({ type: 'flower', tile: 'red', tiles: ['red'] })
      announce(`${player.name} 红中开杠`, 'red')
      if (player.redCount >= 4) {
        endGame(playerIndex, { fourRed: true })
        return false
      }
      return drawFor(playerIndex, true)
    }
    // 保留刚摸到的牌在最右端，出牌前不要混入已整理的手牌。
    player.hand = [...player.hand, tile]
    player.drawnTileIndex = player.hand.length - 1
    return true
  }

  function beginTurn(playerIndex, options = {}) {
    if (phase.value === 'settled') return
    if (!wall.value.length) return endDraw()
    currentPlayer.value = playerIndex
    phase.value = 'drawing'
    selectedIndex.value = -1
    actionPrompt.value = null
    const drawn = options.skipDraw ? true : drawFor(playerIndex, options.fromTail)
    if (!drawn || phase.value === 'settled') return

    if (playerIndex === 0) {
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

  function playAI(playerIndex) {
    if (phase.value === 'settled' || currentPlayer.value !== playerIndex) return
    const player = players[playerIndex]
    if (isWinningHand(player.hand, structuralMeldCount(player))) return endGame(playerIndex)

    const added = player.melds.findIndex((meld) => meld.type === 'peng' && player.hand.includes(meld.tile))
    if (added >= 0) {
      const tile = player.melds[added].tile
      if (canRobKong(user.value.hand, tile, structuralMeldCount(user.value))) {
        pendingKong.value = { playerIndex, meldIndex: added, tile }
        actionPrompt.value = { type: 'rob', tile, from: playerIndex }
        phase.value = 'prompt'
        return
      }
      return completeAddedKong(playerIndex, added, tile)
    }

    const concealed = concealedKongs(player.hand)
    if (concealed.length) {
      performConcealedKong(playerIndex, concealed[0])
      announce(`${player.name} 暗杠`, 'gold')
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
    player.discards.push(tile)
    lastDiscard.value = { tile, from: playerIndex, id: Date.now() }
    phase.value = 'checking'
    window.clearInterval(countdownHandle)

    if (playerIndex !== 0) {
      const count = matchingCount(user.value.hand, tile)
      if (count >= 2 && tile !== 'white' && tile !== 'red') {
        actionPrompt.value = { type: 'claim', tile, from: playerIndex, canGang: count >= 3 }
        phase.value = 'prompt'
        return
      }
    } else {
      const claimant = findAIClaim(tile)
      if (claimant >= 0) return later(() => aiClaim(claimant, tile), 500)
    }
    later(() => beginTurn((playerIndex + 1) % 4), 450)
  }

  function findAIClaim(tile) {
    if (tile === 'white' || tile === 'red') return -1
    for (let step = 1; step < 4; step += 1) {
      const index = step
      if (matchingCount(players[index].hand, tile) >= 2) return index
    }
    return -1
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

  function aiClaim(playerIndex, tile) {
    if (phase.value === 'settled') return
    const player = players[playerIndex]
    player.drawnTileIndex = -1
    const from = lastDiscard.value.from
    const isGang = matchingCount(player.hand, tile) >= 3
    removeLastDiscard(from, tile)
    if (isGang) {
      player.hand = removeMatches(player.hand, tile, 3)
      player.melds.push({ type: 'gang', tile, tiles: [tile, tile, tile, tile] })
      announce(`${player.name} 杠`, 'gold')
      currentPlayer.value = playerIndex
      if (drawFor(playerIndex, true)) later(() => playAI(playerIndex), 550)
    } else {
      player.hand = removeMatches(player.hand, tile, 2)
      player.melds.push({ type: 'peng', tile, tiles: [tile, tile, tile] })
      announce(`${player.name} 碰`, 'gold')
      currentPlayer.value = playerIndex
      phase.value = 'thinking'
      later(() => discardTile(playerIndex, chooseAIDiscard(player)), 650)
    }
  }

  function selectTile(index) {
    if (!isUserTurn.value) return
    if (selectedIndex.value === index) return userDiscard()
    selectedIndex.value = index
  }

  function userDiscard() {
    if (!isUserTurn.value || selectedIndex.value < 0) return
    const index = selectedIndex.value
    selectedIndex.value = -1
    discardTile(0, index)
  }

  function userPass() {
    const prompt = actionPrompt.value
    actionPrompt.value = null
    if (!prompt) return
    if (prompt.type === 'rob') {
      const kong = pendingKong.value
      pendingKong.value = null
      return completeAddedKong(kong.playerIndex, kong.meldIndex, kong.tile)
    }
    beginTurn((prompt.from + 1) % 4)
  }

  function userPeng() {
    const prompt = actionPrompt.value
    if (prompt?.type !== 'claim') return
    removeLastDiscard(prompt.from, prompt.tile)
    user.value.hand = removeMatches(user.value.hand, prompt.tile, 2)
    user.value.drawnTileIndex = -1
    user.value.melds.push({ type: 'peng', tile: prompt.tile, tiles: [prompt.tile, prompt.tile, prompt.tile] })
    actionPrompt.value = null
    currentPlayer.value = 0
    phase.value = 'discard'
    selectedIndex.value = -1
    startCountdown()
    announce('碰', 'gold')
  }

  function userGangFromDiscard() {
    const prompt = actionPrompt.value
    if (prompt?.type !== 'claim' || !prompt.canGang) return
    removeLastDiscard(prompt.from, prompt.tile)
    user.value.hand = removeMatches(user.value.hand, prompt.tile, 3)
    user.value.drawnTileIndex = -1
    user.value.melds.push({ type: 'gang', tile: prompt.tile, tiles: Array(4).fill(prompt.tile) })
    actionPrompt.value = null
    currentPlayer.value = 0
    announce('杠 · 尾牌补摸', 'gold')
    later(() => beginTurn(0, { fromTail: true }), 350)
  }

  function performConcealedKong(playerIndex, tile) {
    const player = players[playerIndex]
    player.hand = removeMatches(player.hand, tile, 4)
    player.drawnTileIndex = -1
    player.melds.push({ type: 'angang', tile, tiles: [tile, tile, tile, tile] })
    if (playerIndex === 0) later(() => beginTurn(0, { fromTail: true }), 350)
    else if (drawFor(playerIndex, true)) phase.value = 'thinking'
  }

  function completeAddedKong(playerIndex, meldIndex, tile) {
    const player = players[playerIndex]
    player.hand = removeMatches(player.hand, tile, 1)
    player.drawnTileIndex = -1
    player.melds[meldIndex] = { type: 'gang', tile, tiles: [tile, tile, tile, tile] }
    announce(`${player.name} 补杠`, 'gold')
    if (playerIndex === 0) later(() => beginTurn(0, { fromTail: true }), 350)
    else if (drawFor(playerIndex, true)) later(() => playAI(playerIndex), 500)
  }

  function userGang(tile = userKongs.value[0]) {
    if (!tile || !isUserTurn.value) return
    window.clearInterval(countdownHandle)
    const meldIndex = user.value.melds.findIndex((meld) => meld.type === 'peng' && meld.tile === tile)
    if (meldIndex >= 0) completeAddedKong(0, meldIndex, tile)
    else {
      performConcealedKong(0, tile)
      announce('暗杠 · 尾牌补摸', 'gold')
    }
  }

  function userHu() {
    if (actionPrompt.value?.type === 'rob') return endGame(0, { robbedKong: true })
    if (userCanHu.value) endGame(0)
  }

  function endGame(winnerIndex, options = {}) {
    clearTimers()
    phase.value = 'settled'
    currentPlayer.value = -1
    actionPrompt.value = null
    const winner = players[winnerIndex]
    const { horses, hits } = drawHorses(wall.value, 8)
    const score = scoreHand({
      dealer: winnerIndex === dealer.value,
      noJoker: !winner.hand.includes('white'),
      fourRed: Boolean(options.fourRed),
      horseHits: hits,
      robbedKong: Boolean(options.robbedKong),
    })
    players.forEach((player, index) => {
      player.score += index === winnerIndex ? score.points * 3 : -score.points
    })
    result.value = { winnerIndex, winner: winner.name, horses, hits, ...score, ...options }
    announcement.value = null
  }

  function endDraw() {
    clearTimers()
    phase.value = 'settled'
    currentPlayer.value = -1
    actionPrompt.value = null
    result.value = { draw: true, winner: '荒庄', horses: [], hits: 0, multiplier: 0, points: 0, details: [] }
  }

  function nextRound() {
    round.value += 1
    startGame()
  }

  onBeforeUnmount(clearTimers)

  return {
    phase, players, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
    actionPrompt, announcement, result, round, dealer, user, isUserTurn, userCanHu,
    userKongs, startGame, selectTile, userDiscard, userPass, userPeng, userGangFromDiscard,
    userGang, userHu, nextRound, tileName,
  }
}
