import { computed, onBeforeUnmount, ref } from 'vue'
import { defineGamePort } from '../contracts/gamePort'
import { performDiscardGang, performPeng } from '../rules/actions'
import type { ActionContext } from '../rules/actions'
import { AiController, HumanController, type PlayerController, type HumanBridge } from '../controllers/playerController'
import { concealedKongs, isWinningHand, matchingCount, waitingTiles } from '../rules/rules'
import { createWall, shuffle, sortTiles, tileAudioFile, tileName, TILE_TYPES } from '../rules/tiles'
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
import { MATCH_NAMES, PACE_MS } from './localGameConfig'
import { createLocalGameState } from './localGameState'
import { createLocalKongActionExecutor } from './localKongActionExecutor'
import { createLocalOpeningTimeline } from './localOpeningTimeline'
import { createLocalSettlementTimeline } from './localSettlementTimeline'
import { createLocalTurnOrchestrator } from './localTurnOrchestrator'
import { advanceMatchState } from './matchProgress'

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
  const timers = new Set<number>()
  let countdownHandle: number | null = null
  let openingTimeline!: ReturnType<typeof createLocalOpeningTimeline>
  let settlementTimeline!: ReturnType<typeof createLocalSettlementTimeline>
  let kongActionExecutor!: ReturnType<typeof createLocalKongActionExecutor>
  let turnOrchestrator!: ReturnType<typeof createLocalTurnOrchestrator>

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
    openingTimeline?.cancel()
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

  function takeTile(fromTail = false) {
    if (!wall.value.length) return null
    if (!fromTail) wallHeadDrawn.value += 1
    return fromTail ? wall.value.pop() : wall.value.shift()
  }

  function wait(delay: number): Promise<void> {
    return new Promise((resolve) => later(resolve, delay))
  }

  function endGame(winnerIndex: number, options: EndGameOptions = {}) {
    return settlementTimeline.endGame(winnerIndex, options)
  }

  function endDraw() {
    return settlementTimeline.endDraw()
  }

  settlementTimeline = createLocalSettlementTimeline({
    state,
    clearTimers,
    later,
    playSound,
    showTableAction,
    structuralMeldCount: (playerIndex) => structuralMeldCount(players[playerIndex]),
    getRoundLabel: () => roundLabel.value,
  })

  openingTimeline = createLocalOpeningTimeline({
    state,
    clearTimers,
    takeTile,
    wait,
    later,
    playSound,
    playSoundAndWait,
    announce,
    getRoundLabel: () => roundLabel.value,
    beginTurn,
    endGame,
  })
  const startGame = openingTimeline.start
  const resetPlayers = openingTimeline.resetPlayers

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
    turnOrchestrator.markDrawSource(playerIndex, fromTail)
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

  function beginTurn(playerIndex: number, options: { skipDraw?: boolean; fromTail?: boolean } = {}) {
    return turnOrchestrator.beginTurn(playerIndex, options)
  }

  function discardTile(playerIndex, handIndex) {
    const player = players[playerIndex]
    // 越界索引 clamp 到末张（对齐后端 manager.discard_tile），避免 splice 落空导致卡死在 checking
    handIndex = Math.min(handIndex, player.hand.length - 1)
    const [tile] = player.hand.splice(handIndex, 1)
    if (!tile) return
    player.hand = sortTiles(player.hand)
    player.drawnTileIndex = -1
    turnOrchestrator.clearDrawSource()
    player.discards.push(tile)
    controllers[playerIndex].onDiscarded?.()
    lastDiscard.value = { tile, from: playerIndex, id: Date.now() }
    playSound('dapai.mp3', 0.8)
    later(() => playSound(tileAudioFile(tile)), 80)
    phase.value = 'checking'
    window.clearInterval(countdownHandle)

    turnOrchestrator.routeDiscard(playerIndex, tile)
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

  kongActionExecutor = createLocalKongActionExecutor({
    state,
    showTableAction,
    showScoreFlow,
    playSound,
    later,
    beginTurn,
  })

  turnOrchestrator = createLocalTurnOrchestrator({
    state,
    controllers,
    tableContext,
    structuralMeldCount: (playerIndex) => structuralMeldCount(players[playerIndex]),
    drawFor,
    performConcealedKong: kongActionExecutor.performConcealedKong,
    declareAddedKong: kongActionExecutor.declareAddedKong,
    settleAddedKong: kongActionExecutor.settleAddedKong,
    discardTile,
    endDraw,
    endGame,
    announce,
    later,
  })

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
      return kongActionExecutor.settleAddedKong(kong.playerIndex)
    }
    // 控制器模式：resolve 待处理的 claim promise
    if (humanController.hasPendingClaim()) {
      humanController.resolveClaimPass()
      return
    }
    // 兼容测试的同步路径
    void turnOrchestrator.offerNextClaim(prompt.remainingClaims ?? [], prompt.tile, prompt.from)
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
    if (meldIndex >= 0) turnOrchestrator.requestAddedKong(0, meldIndex, tile)
    else {
      void kongActionExecutor.performConcealedKong(0, tile)
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
    if (userCanHu.value) endGame(0, { kongBloom: turnOrchestrator.isKongDraw(0) })
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
