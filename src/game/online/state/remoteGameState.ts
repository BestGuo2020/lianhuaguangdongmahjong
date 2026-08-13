import { reactive, ref } from 'vue'
import type { RoomSeatState } from '../api/roomApi'
import type { ActionPrompt, Announcement, GamePhase, LastDiscard, OpeningStage, RoundResult, WinEffect } from '../../core/contracts/gamePort'
import type {
  GamePlayer,
  MatchType,
  ScoreFlowEvent,
  TableActionEvent,
  TileType,
  WinPresentation,
} from '../../core/contracts/types'
import type { RemoteSessionStatus } from '../session/remoteRoomLifecycle'
import type { StoredSession } from '../session/remoteSessionStore'
import type { RuleVariant } from '../../core/rules/ruleVariants'

export type RemoteClientPhase = GamePhase

export interface RemoteGameStateOptions {
  guestId?: string
  storedSession?: StoredSession | null
  autoPlay?: boolean
}

function autoPlayFromUrl(): boolean {
  return typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('auto') === '1'
}

export function createRemoteGameState(options: RemoteGameStateOptions = {}) {
  // 房间与连接会话。
  const sessionStatus = ref<RemoteSessionStatus>('idle')
  const sessionError = ref('')
  const roomId = ref('')
  const mySeat = ref(-1)
  const nickname = ref('')
  const rejoinCode = ref('')
  const playerId = ref(options.guestId ?? '')
  const creatorSeat = ref<number | null>(null)
  const isCreator = ref(false)
  const roomSeats = ref<Array<RoomSeatState | null>>([])
  const roomTimeLimit = ref<number | null>(null)
  const rulesetId = ref<RuleVariant>('lotus-classic')
  const autoPlay = ref(options.autoPlay ?? autoPlayFromUrl())
  const storedSession = ref<StoredSession | null>(options.storedSession ?? null)

  // 服务端权威对局状态与客户端表现状态。
  const phase = ref<RemoteClientPhase>('lobby')
  const players = reactive<GamePlayer[]>([])
  const wallCount = ref(0)
  const wall = ref<TileType[]>([])
  const wallHeadDrawn = ref(0)
  const currentPlayer = ref(-1)
  const selectedIndex = ref(-1)
  const turnSeconds = ref(12)
  const lastDiscard = ref<LastDiscard | null>(null)
  const actionPrompt = ref<ActionPrompt | null>(null)
  const announcement = ref<Announcement | null>(null)
  const tableActionEvent = ref<TableActionEvent | null>(null)
  const scoreFlowEvent = ref<ScoreFlowEvent | null>(null)
  const result = ref<RoundResult | null>(null)
  const winEffect = ref<WinEffect | null>(null)
  const winPresentation = ref<WinPresentation | null>(null)
  const revealHands = ref(false)
  const winningPlayerIndex = ref(-1)
  const round = ref(1)
  const dealer = ref(0)
  const honba = ref(0)
  const matchType = ref<MatchType>('east')
  const matchFinished = ref(false)
  const dealAnimation = ref({ playerIndex: -1, count: 0, serial: 0 })
  const openingStage = ref<OpeningStage | null>(null)
  const diceValues = ref([1, 1])
  const diceThrowerIndex = ref(0)
  const userDrewThisTurn = ref(false)
  const waitingNextRound = ref(false)
  const secondDice = ref<[number, number]>([1, 1])
  const flipTile = ref<TileType | null>(null)
  const jokerTiles = ref<TileType[]>([])
  const wildcardTiles = ref<TileType[]>([])
  const flipStack = ref<number | null>(null)
  const openingStack = ref<number | null>(null)
  const wallBreakIndex = ref(0)
  const turnCanHu = ref(false)
  const turnCanWindKong = ref(false)

  return {
    sessionStatus, sessionError, roomId, mySeat, nickname, rejoinCode, playerId,
    creatorSeat, isCreator, roomSeats, roomTimeLimit, rulesetId, autoPlay, storedSession,
    phase, players, wallCount, wall, wallHeadDrawn, currentPlayer, selectedIndex,
    turnSeconds, lastDiscard, actionPrompt, announcement, tableActionEvent,
    scoreFlowEvent, result, winEffect, winPresentation, revealHands,
    winningPlayerIndex, round, dealer, honba, matchType, matchFinished,
    dealAnimation, openingStage, diceValues, diceThrowerIndex, userDrewThisTurn, waitingNextRound,
    secondDice, flipTile, jokerTiles, wildcardTiles, flipStack, openingStack, wallBreakIndex,
    turnCanHu, turnCanWindKong,
  }
}

export type RemoteGameState = ReturnType<typeof createRemoteGameState>
