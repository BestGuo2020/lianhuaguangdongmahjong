import { computed, onBeforeUnmount, ref } from 'vue'
import { defineGamePort } from '../contracts/gamePort'
import { performDiscardGang, performPeng, removeMatches } from '../rules/actions'
import type { ActionContext } from '../rules/actions'
import { AiController, HumanController, type PlayerController, type HumanBridge, type ActionPrompt, type ClaimContext, type RobKongContext, type TurnContext } from '../controllers/playerController'
import { applyKongScore, applyWinScore, concealedKongs, canRobKong, drawHorses, isWinningHand, matchingCount, scoreHand, waitingTiles } from '../rules/rules'
import { createWall, shuffle, sortTiles, tileAudioFile, tileName, TILE_TYPES } from '../rules/tiles'
import { wallBreakIndex } from '../rules/wallLayout'
import type {
  EndGameOptions,
  GamePlayer,
  MatchType,
  ScoreDelta,
  ScoreFlowEvent,
  TableActionEvent,
  TableActionType,
  TileType,
} from '../contracts/types'
import {
  prefersReducedMotion,
  REDUCED_WIN_EFFECT_DURATION,
  REDUCED_WIN_REVEAL_DURATION,
  WIN_EFFECT_DURATION,
  WIN_EFFECT_SOUND_DELAY,
  WIN_REVEAL_DURATION,
} from '../presentation/winEffect'
import { MATCH_HANDS, MATCH_NAMES, PACE_MS, PLAYER_SEED } from './localGameConfig'
import { createLocalGameState } from './localGameState'
import { advanceMatchState, resolveWinTile } from './matchProgress'

interface UseGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  controllers?: PlayerController[]
}

export function useGame({ playSound = () => {}, playSoundAndWait = async () => {}, controllers: optControllers }: UseGameOptions = {}) {
  const state = createLocalGameState()
  const {
    phase, players, wall, wallHeadDrawn, currentPlayer, selectedIndex, turnSeconds,
    lastDiscard, actionPrompt, pendingKong, announcement, tableActionEvent,
    scoreFlowEvent, result, winEffect, winPresentation, revealHands,
    winningPlayerIndex, round, dealer, matchType, honba, matchFinished,
    dealAnimation, openingStage, diceValues, userDrewThisTurn,
  } = state
  let kongDrawPlayerIndex = -1
  const timers = new Set<number>()
  let countdownHandle: number | null = null
  let openingSequence = 0

  // ── 默认控制器装配（不传 controllers 时自动构建 1 人类 + 3 AI）──
  const humanBridge: HumanBridge = {
    isTurn: ref(false),
    canHu: ref(false),
    canKong: ref<TileType[]>([]),
    actionPrompt,
    selectedIndex,
    drawnThisTurn: userDrewThisTurn,
    turnSeconds,
    activateTurn() {
      phase.value = 'discard'
      startCountdown()
    },
    activateClaim() {
      phase.value = 'prompt'
      startPromptCountdown()
    },
    activateRobKong() {
      phase.value = 'prompt'
      announce('可抢杠胡', 'red')
      startPromptCountdown()
    },
    deactivate() {
      window.clearInterval(countdownHandle)
      countdownHandle = null
    },
  }
  const humanController = new HumanController(humanBridge)
  const controllers: PlayerController[] = optControllers ?? [
    humanController,
    new AiController(),
    new AiController(),
    new AiController(),
  ]

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
    controllers.forEach((c) => c.reset?.())
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
    if (!fromTail) wallHeadDrawn.value += 1
    return fromTail ? wall.value.pop() : wall.value.shift()
  }

  function dealOne(player: GamePlayer) {
    const tile = takeTile(false)
    if (!tile) return
    receiveDealtTile(player, tile)
  }

  function receiveDealtTile(player: GamePlayer, tile) {
    // 发牌阶段红中先入正常手牌，发完牌后统一从牌墙尾补杠（见 resolveDealtReds），
    // 避免发牌过程中牌山就因红中补张而少牌。
    player.hand.push(tile)
  }

  // 发完牌后处理红中：若手牌有红中，依次逆时针（庄家起）从牌墙尾补张。
  function resolveDealtReds() {
    const seatOrder = players.map((_, offset) => (dealer.value + offset) % players.length)
    for (const playerIndex of seatOrder) {
      const player = players[playerIndex]
      while (player.hand.includes('red')) {
        // 已有 3 张红中亮花杠，再发到第 4 张 → 四红中：红中留手牌作胡牌牌，不再亮花杠/补张
        if (player.redCount >= 3) {
          player.redCount += 1
          break
        }
        player.hand.splice(player.hand.indexOf('red'), 1)
        player.redCount += 1
        player.melds.push({ type: 'flower', tile: 'red', tiles: ['red'] })
        const replacement = takeTile(true)
        if (replacement) player.hand.push(replacement)  // 补到红中则由 while 继续转
      }
    }
  }

  function wait(delay: number): Promise<void> {
    return new Promise((resolve) => later(resolve, delay))
  }

  function hasSettled() {
    return phase.value === 'settled'
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
    wallHeadDrawn.value = 0
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

    // 骰子决定拆墙点（莲花广麻规则，与后端 _break_wall_by_dice 一致）：
    // 和数定拆哪家墙（5/9→庄，2/6/10→下，3/7/11→对，4/8/12→上），小点数定列；旋转列表让拆墙处成为前端。
    const breakIndex = wallBreakIndex(diceValues.value)
    wall.value = [...wall.value.slice(breakIndex), ...wall.value.slice(0, breakIndex)]

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
    // 庄家跳牌：其余三家各补一张之前，庄家先抓上层两张（隔一墩）。
    // 依次从墙头取 5 张：第 1、5 张给庄家（隔开中间），第 2、3、4 张给下家/对家/上家。
    const jumpTiles = Array.from({ length: 5 }, () => takeTile(false))
    const jumpOrder = [dealer.value, seatOrder[1], seatOrder[2], seatOrder[3], dealer.value]
    jumpOrder.forEach((playerIndex, index) => {
      if (jumpTiles[index]) receiveDealtTile(players[playerIndex], jumpTiles[index])
    })
    dealAnimation.value = { playerIndex: dealer.value, count: 2, serial: dealAnimation.value.serial + 1 }
    await wait(260)
    for (const other of [seatOrder[1], seatOrder[2], seatOrder[3]]) {
      dealAnimation.value = { playerIndex: other, count: 1, serial: dealAnimation.value.serial + 1 }
      await wait(150)
    }
    if (sequence !== openingSequence) return
    // 发完牌后统一处理红中补杠（逆时针从牌墙尾补张），避免发牌中牌山就少牌
    resolveDealtReds()
    phase.value = 'opening'
    openingStage.value = null
    dealAnimation.value = { playerIndex: -1, count: 0, serial: dealAnimation.value.serial + 1 }
    players.forEach((player) => { player.hand = sortTiles(player.hand) })
    const fourRedWinner = players.findIndex((player) => player.redCount >= 4)
    if (fourRedWinner >= 0) return endGame(fourRedWinner, { fourRed: true })
    announce(`${roundLabel.value} · 开牌`)
    // 庄家已因跳牌持有 14 张：首回合跳过摸牌直接出牌
    later(() => beginTurn(dealer.value, { skipDraw: true }), 650)
  }

  function startCountdown() {
    window.clearInterval(countdownHandle)
    turnSeconds.value = 12
    countdownHandle = window.setInterval(() => {
      if (phase.value !== 'discard' || currentPlayer.value !== 0) return
      turnSeconds.value -= 1
      // 倒计时到 3 秒：播一次提示音
      if (turnSeconds.value === 3) playSound('didu.ogg')
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
      // 倒计时到 3 秒：播一次提示音
      if (turnSeconds.value === 3) playSound('didu.ogg')
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
      if (player.redCount >= 4) {
        // 四红中：第 4 张红中直接作为胡牌牌进手牌（不再亮花杠/补张），位置随摸牌最右端，
        // 由胡牌展示 splitWinningTile 抽到赢牌位置。
        player.hand = [...player.hand, tile]
        player.drawnTileIndex = player.hand.length - 1
        playSound('give.mp3', 0.7)
        endGame(playerIndex, { fourRed: true })
        return false
      }
      player.melds.push({ type: 'flower', tile: 'red', tiles: ['red'] })
      showTableAction('flower-gang', playerIndex, null, tile, player.melds.length - 1)
      // 红中先完成亮杠与报杠音效，再从牌墙尾补摸，避免两个动画挤在一起；
      // 至少停顿 redKongDraw 再补摸，对齐人类正常节奏（AI 与用户一致）。
      await Promise.all([playSoundAndWait('gang.mp3'), wait(PACE_MS.redKongDraw)])
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
    if (!drawn || hasSettled()) return

    phase.value = 'thinking'
    const player = players[playerIndex]
    const ctx: TurnContext = {
      hand: player.hand,
      melds: player.melds,
      exposedMelds: structuralMeldCount(player),
      kongBloom: kongDrawPlayerIndex === playerIndex,
      skipDraw: Boolean(options.skipDraw),
      afterKong: Boolean(options.fromTail),
    }
    const action = await controllers[playerIndex].requestTurn(ctx)
    // 守卫：游戏可能已在 await 期间结束或轮次已转移
    if (hasSettled() || currentPlayer.value !== playerIndex) return

    switch (action.kind) {
      case 'win':
        return endGame(playerIndex, { kongBloom: kongDrawPlayerIndex === playerIndex })
      case 'added-kong':
        return requestAddedKong(playerIndex, action.meldIndex, player.melds[action.meldIndex].tile)
      case 'concealed-kong':
        await performConcealedKong(playerIndex, action.tile, { noContinue: true })
        if (hasSettled()) return
        return beginTurn(playerIndex, { fromTail: true })
      case 'discard':
        return discardTile(playerIndex, action.handIndex)
    }
  }

  function discardTile(playerIndex, handIndex) {
    const player = players[playerIndex]
    // 越界索引 clamp 到末张（对齐后端 manager.discard_tile），避免 splice 落空导致卡死在 checking
    handIndex = Math.min(handIndex, player.hand.length - 1)
    const [tile] = player.hand.splice(handIndex, 1)
    if (!tile) return
    player.hand = sortTiles(player.hand)
    player.drawnTileIndex = -1
    kongDrawPlayerIndex = -1
    player.discards.push(tile)
    controllers[playerIndex].onDiscarded?.()
    lastDiscard.value = { tile, from: playerIndex, id: Date.now() }
    playSound('dapai.mp3', 0.8)
    later(() => playSound(tileAudioFile(tile)), 80)
    phase.value = 'checking'
    window.clearInterval(countdownHandle)

    const claimants = findClaims(playerIndex, tile)
    if (claimants.length) return offerNextClaim(claimants, tile, playerIndex)
    later(() => beginTurn((playerIndex + 1) % 4), PACE_MS.afterDiscardToNextTurn)
  }

  function seatDistance(from, to) {
    return (to - from + players.length) % players.length
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

  // 共享执行的上下文：把可变状态与表现副作用注入 actions.ts 的执行函数，
  // 让用户与 AI 复用同一套碰/杠物理操作。
  const tableContext: ActionContext = {
    players,
    currentPlayer,
    showTableAction,
    showScoreFlow,
    playSound,
  }

  async function offerNextClaim(claimants, tile, from) {
    const [claimant, ...remainingClaims] = claimants
    if (!claimant) return later(() => beginTurn((from + 1) % 4), PACE_MS.afterDiscardToNextTurn)

    const player = players[claimant.playerIndex]
    const ctx: ClaimContext = {
      hand: player.hand,
      canGang: claimant.canGang,
      tile,
      from,
    }
    const action = await controllers[claimant.playerIndex].requestClaim(ctx)
    // 守卫：游戏可能已在 await 期间结束
    if (phase.value === 'settled') return

    switch (action.kind) {
      case 'pass':
        return offerNextClaim(remainingClaims, tile, from)
      case 'gang':
        performDiscardGang(tableContext, claimant.playerIndex, tile, from)
        // 杠后补摸只由 beginTurn(fromTail) 完成：这里不能再 drawFor，
        // 否则点杠会连摸两张（补摸 + 回合摸），四副露时手牌多一张，不再是单骑。
        later(() => beginTurn(claimant.playerIndex, { fromTail: true }), PACE_MS.afterClaimGang)
        return
      case 'peng':
        performPeng(tableContext, claimant.playerIndex, tile, from)
        if (action.discardIndex !== undefined) {
          // AI 单次事件：碰 + 弃牌一次跨边界完成（延迟用于动画展示）
          later(() => discardTile(claimant.playerIndex, action.discardIndex), PACE_MS.afterClaimPeng)
        } else {
          // 人类：碰后需要互动选弃牌
          later(() => beginTurn(claimant.playerIndex, { skipDraw: true }), PACE_MS.skipDrawPengDelay)
        }
        return
    }
  }

  function selectTile(index) {
    if (!isUserTurn.value) return
    selectedIndex.value = index
    playSound('click.mp3', 0.65)
  }

  function clearUserSelection() {
    selectedIndex.value = -1
  }

  function userDiscard(index = selectedIndex.value) {
    // 控制器模式：resolve 待处理的 turn promise，由 beginTurn 的 await 继续流程
    if (humanController.hasPendingTurn()) {
      humanController.resolveDiscard(index)
      return
    }
    // 兼容测试的同步路径（无待处理 promise 时直驱执行）
    if (!isUserTurn.value || index < 0 || index >= user.value.hand.length) return
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
      // 控制器模式（Step 5 将进一步迁移）
      if (humanController.hasPendingRobKong()) {
        humanController.resolveRobKongAction('pass')
        return
      }
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
    // 控制器模式：resolve 待处理的 claim promise
    if (humanController.hasPendingClaim()) {
      humanController.resolveClaimPass()
      return
    }
    // 兼容测试的同步路径
    offerNextClaim(prompt.remainingClaims ?? [], prompt.tile, prompt.from)
  }

  function userPeng() {
    // 控制器模式：resolve 待处理的 claim promise
    if (humanController.hasPendingClaim()) {
      humanController.resolveClaimPeng()
      return
    }
    // 兼容测试的同步路径
    const prompt = actionPrompt.value
    if (prompt?.type !== 'claim') return
    window.clearInterval(countdownHandle)
    countdownHandle = null
    performPeng(tableContext, 0, prompt.tile, prompt.from)
    actionPrompt.value = null
    userDrewThisTurn.value = false
    phase.value = 'discard'
    selectedIndex.value = -1
    startCountdown()
  }

  function userGangFromDiscard() {
    // 控制器模式：resolve 待处理的 claim promise
    if (humanController.hasPendingClaim()) {
      humanController.resolveClaimGang()
      return
    }
    // 兼容测试的同步路径
    const prompt = actionPrompt.value
    if (prompt?.type !== 'claim' || !prompt.canGang) return
    window.clearInterval(countdownHandle)
    countdownHandle = null
    performDiscardGang(tableContext, 0, prompt.tile, prompt.from)
    actionPrompt.value = null
    userDrewThisTurn.value = false
    later(() => beginTurn(0, { fromTail: true }), 350)
  }

  async function performConcealedKong(playerIndex, tile, { noContinue = false } = {}) {
    const player = players[playerIndex]
    player.hand = removeMatches(player.hand, tile, 4)
    player.drawnTileIndex = -1
    player.melds.push({ type: 'angang', tile, tiles: [tile, tile, tile, tile] })
    const scoreDeltas = applyKongScore(players, playerIndex, 'concealed')
    showTableAction('concealed-gang', playerIndex, null, tile, player.melds.length - 1)
    showScoreFlow(scoreDeltas)
    playSound('gang.mp3')
    if (noContinue) return
    // 遗留路径（测试直驱 userGang / performConcealedKong）：beginTurn 统一处理补摸+决策
    later(() => beginTurn(playerIndex, { fromTail: true }), 350)
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
    // 延迟用于杠结算动画展示，之后 beginTurn 统一处理补摸+决策
    later(() => beginTurn(playerIndex, { fromTail: true }), PACE_MS.afterKongSettle)
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
    if (robberIndex === undefined) return later(() => settleAddedKong(playerIndex), PACE_MS.beforeRobKong)

    pendingKong.value = { playerIndex, meldIndex, tile, remainingRobbers }
    later(() => offerRobKong(robberIndex), PACE_MS.beforeRobKong)
  }

  async function offerRobKong(robberIndex) {
    const kong = pendingKong.value
    if (!kong || phase.value === 'settled') return

    const robber = players[robberIndex]
    const ctx: RobKongContext = {
      hand: robber.hand,
      exposedMelds: structuralMeldCount(robber),
      tile: kong.tile,
      from: kong.playerIndex,
    }
    const action = await controllers[robberIndex].requestRobKong(ctx)
    // 守卫：await 期间游戏可能已结束或 kong 已被处理
    if (hasSettled() || pendingKong.value !== kong) return

    if (action === 'pass') {
      const [nextRobber, ...rest] = kong.remainingRobbers ?? []
      if (nextRobber === undefined) return settleAddedKong(kong.playerIndex)
      pendingKong.value = { ...kong, remainingRobbers: rest }
      return later(() => offerRobKong(nextRobber), PACE_MS.betweenRobKongs)
    }

    announce(`${players[robberIndex].name} 抢杠胡`, 'red')
    pendingKong.value = null
    later(() => endGame(robberIndex, { robbedKong: true, robbedKongPlayerIndex: kong.playerIndex, winTile: kong.tile }), PACE_MS.betweenRobKongs)
  }

  function userGang(tile = userKongs.value[0]) {
    if (!tile) return
    // 控制器模式：resolve 待处理的 turn promise
    if (humanController.hasPendingTurn()) {
      const meldIndex = user.value.melds.findIndex((meld) => meld.type === 'peng' && meld.tile === tile)
      if (meldIndex >= 0) {
        humanController.resolveAddedKong(meldIndex)
      } else {
        humanController.resolveConcealedKong(tile)
      }
      return
    }
    // 兼容测试的同步路径
    if (!isUserTurn.value) return
    userDrewThisTurn.value = false
    window.clearInterval(countdownHandle)
    const meldIndex = user.value.melds.findIndex((meld) => meld.type === 'peng' && meld.tile === tile)
    if (meldIndex >= 0) requestAddedKong(0, meldIndex, tile)
    else {
      performConcealedKong(0, tile)
    }
  }

  function userHu() {
    // 控制器模式：优先 resolve 待处理的 promise
    if (humanController.hasPendingRobKong()) {
      humanController.resolveRobKongAction('win')
      return
    }
    if (humanController.hasPendingTurn()) {
      humanController.resolveWin()
      return
    }
    // 兼容测试的同步路径
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
    scoreFlowEvent.value = null
    tableActionEvent.value = null
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
    // 买马从牌头摸走：同步牌头计数，供 3D 牌山正确显示牌头缺口
    wallHeadDrawn.value += horses.length
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

  /**
   * 开发期杠测试：注入一副带杠候选的手牌并切到本家回合（phase=discard），
   * 让「杠」按钮出现以测试选牌弹窗。dev 构建外为 no-op。
   * mode：concealed=纯暗杠 / added=纯补杠 / both=暗杠与补杠并存。
   */
  function debugPreviewKong(mode: 'concealed' | 'added' | 'both' = 'both') {
    if (!import.meta.env.DEV) return
    clearTimers()
    if (players.length !== 4) resetPlayers()
    const p = players[0]
    p.score = 1000
    p.discards.splice(0)
    p.melds.splice(0)
    p.drawnTileIndex = -1
    p.redCount = 0

    const hands: Record<'concealed' | 'added' | 'both', TileType[]> = {
      // 暗杠：手牌 4×m1；刻意不构成胡牌，聚焦杠测试
      concealed: ['m1', 'm1', 'm1', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east', 'west'],
      // 补杠：已有碰副露 m1 + 手牌 1×m1
      added: ['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east', 'west', 'west', 'north'],
      // 双杠并存：手牌 4×m2 暗杠 + 碰副露 m1 与手牌 1×m1 补杠
      both: ['m2', 'm2', 'm2', 'm2', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east', 'west', 'm1'],
    }
    p.hand.splice(0, p.hand.length, ...hands[mode])
    p.hand = sortTiles(p.hand)
    if (mode !== 'concealed') {
      p.melds.push({ type: 'peng', tile: 'm1', from: 1, tiles: ['m1', 'm1', 'm1'] })
    }

    for (let index = 1; index < 4; index += 1) {
      const opponent = players[index]
      opponent.hand.splice(0, opponent.hand.length,
        'm4', 'm5', 'm6', 'p1', 'p2', 'p3', 's1', 's2', 's3', 's4', 's5', 's6', 's7')
      opponent.melds.splice(0)
      opponent.discards.splice(0)
      opponent.drawnTileIndex = -1
    }

    wall.value = shuffle(createWall())
    wallHeadDrawn.value = 0
    lastDiscard.value = null
    result.value = null
    winEffect.value = null
    winPresentation.value = null
    revealHands.value = false
    winningPlayerIndex.value = -1
    matchFinished.value = false
    actionPrompt.value = null
    dealAnimation.value = { playerIndex: -1, count: 0, serial: dealAnimation.value.serial + 1 }
    openingStage.value = null
    currentPlayer.value = 0
    phase.value = 'discard'
    userDrewThisTurn.value = true
    selectedIndex.value = -1
    announce(
      mode === 'concealed' ? '测试：可暗杠' : mode === 'added' ? '测试：可补杠' : '测试：暗杠+补杠并存',
      'red',
    )
  }

  /** 开发期四红中测试：注入 3 个红中花杠 + 牌头放第 4 张红中，摸牌即四红中胡牌。 */
  function debugPreviewFourRed() {
    if (!import.meta.env.DEV) return
    clearTimers()
    if (players.length !== 4) resetPlayers()
    const p = players[0]
    p.score = 1000
    p.discards.splice(0)
    p.melds.splice(0)
    p.redCount = 3
    p.drawnTileIndex = -1
    for (let index = 0; index < 3; index += 1) {
      p.melds.push({ type: 'flower', tile: 'red', tiles: ['red'] })
    }
    p.hand.splice(0, p.hand.length, 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east', 'west', 'west')

    for (let index = 1; index < 4; index += 1) {
      const opponent = players[index]
      opponent.hand.splice(0, opponent.hand.length,
        'm4', 'm5', 'm6', 'p1', 'p2', 'p3', 's1', 's2', 's3', 's4', 's5', 's6', 's7')
      opponent.melds.splice(0)
      opponent.discards.splice(0)
      opponent.drawnTileIndex = -1
    }

    wall.value = shuffle(createWall())
    // 把一张红中放到牌头：本家摸牌即第 4 张红中 → 四红中
    const redIndex = wall.value.indexOf('red')
    if (redIndex > 0) {
      const head = wall.value[0]
      wall.value[0] = 'red'
      wall.value[redIndex] = head
    }
    wallHeadDrawn.value = 0
    lastDiscard.value = null
    result.value = null
    winEffect.value = null
    winPresentation.value = null
    revealHands.value = false
    winningPlayerIndex.value = -1
    matchFinished.value = false
    actionPrompt.value = null
    dealAnimation.value = { playerIndex: -1, count: 0, serial: dealAnimation.value.serial + 1 }
    openingStage.value = null
    currentPlayer.value = 0
    phase.value = 'drawing'
    announce('测试：摸第 4 张红中 → 四红中胡牌', 'red')
    void beginTurn(0)
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
    // 流局：各家是否听牌（连庄判断 + 结算展示；不付点数）
    const tenpai = players
      .map((player, playerIndex) => ({ playerIndex, waits: waitingTiles(player.hand, structuralMeldCount(player)) }))
      .filter((item) => item.waits.length > 0)
      .map((item) => item.playerIndex)
    result.value = makeRoundResult({
      draw: true, winner: '荒庄', horses: [], hits: 0, multiplier: 0, points: 0, details: [],
      tenpai,
      dealerTenpai: tenpai.includes(dealer.value),
    }, scoresBefore)
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

  return defineGamePort({
    phase, players, wall, wallHeadDrawn, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
    actionPrompt, announcement, tableActionEvent, scoreFlowEvent, result, winEffect, winPresentation, revealHands, winningPlayerIndex,
    round, dealer, user, isUserTurn, userCanHu,
    matchType, matchName, matchFinished, honba, roundLabel, standings,
    dealAnimation, openingStage, diceValues, userCurrentWaits, userTingOptions, userDiscardWaits,
    userKongs, startGame, selectTile, clearUserSelection, userDiscard, userPass, userPeng, userGangFromDiscard,
    userGang, userHu, nextRound, returnToLobby, tileName, debugPreviewWin, debugPreviewKong, debugPreviewFourRed,
    humanController,
  })
}
