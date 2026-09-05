import type { EngineCommand, EngineWindow } from './state'
import { SEATS } from './state'

export const sameAction = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Does not consume a command until identity, eligibility and the whole action match. */
export function acceptWindowDecision(window: EngineWindow, command: EngineCommand, now: number): boolean {
  const seat = command.seat
  if (!SEATS.includes(seat) || window.id !== command.windowId || window.version !== command.stateVersion
    || now < window.opensAt || now >= window.deadlineAt || window.decisions[seat] !== null) return false
  const allowed = window.options[seat].find(a => sameAction(a, command.action))
  if (!allowed) return false
  window.decisions[seat] = allowed
  return true
}

export const windowComplete = (window: EngineWindow) => SEATS.every(s => !window.options[s].length || window.decisions[s] !== null)
