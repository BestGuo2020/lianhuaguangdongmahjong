import { defaultAvatarForSeat } from '../../core/presentation/avatar'
import type { LastDiscard, RoundResult } from '../../core/contracts/gamePort'
import type { GamePlayer, ScoreDelta, TableActionEvent, WinPresentation } from '../../core/contracts/types'
import type { LocalSnapshot, ServerPlayerDto, ServerSnapshot } from './dto'

export function toLocalSeat(serverSeat: number, localServerSeat: number): number {
  return ((serverSeat - localServerSeat + 4) % 4 + 4) % 4
}

export function mapPlayersToLocal(players: ServerPlayerDto[], localServerSeat: number): GamePlayer[] {
  return [...players]
    .sort((a, b) => toLocalSeat(a.seat, localServerSeat) - toLocalSeat(b.seat, localServerSeat))
    .map((player) => ({
      ...player,
      hand: player.hand.filter((tile): tile is NonNullable<typeof tile> => tile !== null),
      concealedTileCount: player.hand.length,
      avatar: player.avatar || defaultAvatarForSeat(player.seat),
      melds: player.melds.map((meld) => (
        meld.from != null
          ? { ...meld, from: toLocalSeat(meld.from, localServerSeat) }
          : meld
      )),
    }))
}

export function mapRoundResultToLocal(
  result: RoundResult | null,
  localServerSeat: number,
): RoundResult | null {
  if (!result) return null
  return {
    ...result,
    winnerIndex: result.winnerIndex != null && result.winnerIndex >= 0
      ? toLocalSeat(result.winnerIndex, localServerSeat)
      : -1,
    robbedKongPlayerIndex: result.robbedKongPlayerIndex != null && result.robbedKongPlayerIndex >= 0
      ? toLocalSeat(result.robbedKongPlayerIndex, localServerSeat)
      : -1,
    tenpai: (result.tenpai ?? []).map((seat: number) => toLocalSeat(seat, localServerSeat)),
    scoreChanges: (result.scoreChanges ?? []).map((change) => ({
      ...change,
      avatar: change.avatar || defaultAvatarForSeat(change.playerIndex),
      fallbackAvatar: defaultAvatarForSeat(change.playerIndex),
      playerIndex: toLocalSeat(change.playerIndex, localServerSeat),
    })),
  }
}

export function mapWinPresentationToLocal(
  presentation: WinPresentation | null,
  localServerSeat: number,
): WinPresentation | null {
  if (!presentation) return null
  return {
    ...presentation,
    winnerIndex: toLocalSeat(presentation.winnerIndex, localServerSeat),
    sourceIndex: presentation.sourceIndex >= 0
      ? toLocalSeat(presentation.sourceIndex, localServerSeat)
      : -1,
    robbedKongPlayerIndex: presentation.robbedKongPlayerIndex >= 0
      ? toLocalSeat(presentation.robbedKongPlayerIndex, localServerSeat)
      : -1,
  }
}

export function mapLastDiscardToLocal(
  discard: LastDiscard | null,
  localServerSeat: number,
): LastDiscard | null {
  return discard
    ? { ...discard, from: toLocalSeat(discard.from, localServerSeat) }
    : null
}

export function mapTableActionToLocal(
  event: TableActionEvent,
  localServerSeat: number,
): TableActionEvent {
  return {
    ...event,
    actorIndex: toLocalSeat(event.actorIndex, localServerSeat),
    sourceIndex: event.sourceIndex != null
      ? toLocalSeat(event.sourceIndex, localServerSeat)
      : null,
  }
}

export function mapScoreDeltasToLocal(
  deltas: ScoreDelta[],
  localServerSeat: number,
): ScoreDelta[] {
  return deltas.map((delta) => ({
    ...delta,
    playerIndex: toLocalSeat(delta.playerIndex, localServerSeat),
  }))
}

export function mapServerSnapshotToLocal(
  snapshot: ServerSnapshot,
  localServerSeat: number,
): LocalSnapshot {
  return {
    ...snapshot,
    dealer: toLocalSeat(snapshot.dealer, localServerSeat),
    currentPlayer: snapshot.currentPlayer >= 0
      ? toLocalSeat(snapshot.currentPlayer, localServerSeat)
      : -1,
    players: mapPlayersToLocal(snapshot.players, localServerSeat),
    result: mapRoundResultToLocal(snapshot.result, localServerSeat),
    lastDiscard: mapLastDiscardToLocal(snapshot.lastDiscard, localServerSeat),
    winPresentation: mapWinPresentationToLocal(snapshot.winPresentation, localServerSeat),
    winningPlayerIndex: snapshot.winningPlayerIndex >= 0
      ? toLocalSeat(snapshot.winningPlayerIndex, localServerSeat)
      : -1,
  }
}
