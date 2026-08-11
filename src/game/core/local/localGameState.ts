import { reactive, ref } from 'vue'
import type {
  Announcement,
  GamePhase,
  LastDiscard,
  OpeningStage,
  RoundResult,
  WinEffect,
} from '../contracts/gamePort'
import type { ActionPrompt } from '../controllers/playerController'
import type {
  GamePlayer,
  MatchType,
  ScoreFlowEvent,
  TableActionEvent,
  TileType,
  WinPresentation,
} from '../contracts/types'

export interface PendingKong {
  playerIndex: number
  meldIndex: number
  tile: TileType
  remainingRobbers: number[]
}

export function createLocalGameState() {
  return {
    phase: ref<GamePhase>('lobby'),
    players: reactive<GamePlayer[]>([]),
    wall: ref<TileType[]>([]),
    wallHeadDrawn: ref(0),
    currentPlayer: ref(-1),
    selectedIndex: ref(-1),
    turnSeconds: ref(12),
    lastDiscard: ref<LastDiscard | null>(null),
    actionPrompt: ref<ActionPrompt | null>(null),
    pendingKong: ref<PendingKong | null>(null),
    announcement: ref<Announcement | null>(null),
    tableActionEvent: ref<TableActionEvent | null>(null),
    scoreFlowEvent: ref<ScoreFlowEvent | null>(null),
    result: ref<RoundResult | null>(null),
    winEffect: ref<WinEffect | null>(null),
    winPresentation: ref<WinPresentation | null>(null),
    revealHands: ref(false),
    winningPlayerIndex: ref(-1),
    round: ref(1),
    dealer: ref(0),
    matchType: ref<MatchType>('east'),
    honba: ref(0),
    matchFinished: ref(false),
    dealAnimation: ref({ playerIndex: -1, count: 0, serial: 0 }),
    openingStage: ref<OpeningStage | null>(null),
    diceValues: ref([1, 1]),
    userDrewThisTurn: ref(false),
  }
}

export type LocalGameState = ReturnType<typeof createLocalGameState>
