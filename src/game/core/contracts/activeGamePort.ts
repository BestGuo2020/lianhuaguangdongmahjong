import { computed, type ComputedRef } from 'vue'
import type { GamePlayer } from './types'
import type { GamePort, RefLike } from './gamePort'

export type GameMode = 'local' | 'remote'

type RefStateKey = {
  [K in keyof GamePort]-?: GamePort[K] extends RefLike<any> ? K : never
}[keyof GamePort]

type ActionKey = {
  [K in keyof GamePort]-?: GamePort[K] extends (...args: any[]) => any ? K : never
}[keyof GamePort]

type RefValue<T> = T extends RefLike<infer V> ? V : never

export type ActiveGamePort = {
  [K in keyof GamePort]: GamePort[K] extends RefLike<infer V>
    ? ComputedRef<V>
    : GamePort[K] extends GamePlayer[]
      ? ComputedRef<GamePlayer[]>
      : GamePort[K]
}

/**
 * 在本地和远程 GamePort 之间建立稳定的响应式视图。
 * 状态始终读取当前模式，动作在调用瞬间委托，切换模式无需重新解构 UI 依赖。
 * localGame 为解析函数：可按所选玩法（莲花广麻/莲花麻将）切换本地引擎。
 */
export function createActiveGamePort(
  mode: RefLike<GameMode>,
  localGame: () => GamePort,
  remoteGame: GamePort,
): ActiveGamePort {
  const active = () => (mode.value === 'remote' ? remoteGame : localGame())

  const state = <K extends RefStateKey>(key: K): ComputedRef<RefValue<GamePort[K]>> => (
    computed(() => active()[key].value) as ComputedRef<RefValue<GamePort[K]>>
  )

  const action = <K extends ActionKey>(key: K): GamePort[K] => (
    ((...args: any[]) => (active()[key] as (...values: any[]) => any)(...args)) as GamePort[K]
  )

  return {
    phase: state('phase'),
    players: computed(() => active().players),
    wall: state('wall'),
    wallHeadDrawn: state('wallHeadDrawn'),
    wallCount: state('wallCount'),
    currentPlayer: state('currentPlayer'),
    selectedIndex: state('selectedIndex'),
    turnSeconds: state('turnSeconds'),
    lastDiscard: state('lastDiscard'),
    actionPrompt: state('actionPrompt'),
    announcement: state('announcement'),
    tableActionEvent: state('tableActionEvent'),
    scoreFlowEvent: state('scoreFlowEvent'),
    result: state('result'),
    winEffect: state('winEffect'),
    winPresentation: state('winPresentation'),
    revealHands: state('revealHands'),
    winningPlayerIndex: state('winningPlayerIndex'),
    round: state('round'),
    dealer: state('dealer'),
    user: state('user'),
    isUserTurn: state('isUserTurn'),
    userCanHu: state('userCanHu'),
    matchType: state('matchType'),
    matchName: state('matchName'),
    matchFinished: state('matchFinished'),
    honba: state('honba'),
    roundLabel: state('roundLabel'),
    standings: state('standings'),
    dealAnimation: state('dealAnimation'),
    openingStage: state('openingStage'),
    diceValues: state('diceValues'),
    diceThrowerIndex: state('diceThrowerIndex'),
    userCurrentWaits: state('userCurrentWaits'),
    userTingOptions: state('userTingOptions'),
    userDiscardWaits: state('userDiscardWaits'),
    userKongs: state('userKongs'),
    capabilities: state('capabilities'),

    startGame: action('startGame'),
    selectTile: action('selectTile'),
    clearUserSelection: action('clearUserSelection'),
    userDiscard: action('userDiscard'),
    userPass: action('userPass'),
    userPeng: action('userPeng'),
    userGangFromDiscard: action('userGangFromDiscard'),
    userGang: action('userGang'),
    userHu: action('userHu'),
    nextRound: action('nextRound'),
    returnToLobby: action('returnToLobby'),
    tileName: action('tileName'),
  }
}
