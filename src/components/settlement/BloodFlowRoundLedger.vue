<script setup lang="ts">
import { computed } from 'vue'
import type { GamePlayer } from '../../game/core/contracts/types'
import type { BloodFlowPublicState } from '../../game/variants/lotus/bloodFlow/types'
import { tileName } from '../../game/core/rules/tiles'
import BloodFlowWinCard from '../table/BloodFlowWinCard.vue'
import type { TableThemeName } from '../table/three/tableTheme'
import { themePresentationByName, themePresentationCssVariables } from '../../theme/themePresentation'

const props = defineProps<{ open: boolean; state: BloodFlowPublicState; players: GamePlayer[]; localSeat?: number; filterSeat?: number | null; matchFinished?: boolean; themeName?: TableThemeName }>()
defineEmits<{ close: []; nextRound: []; returnToLobby: [] }>()
const name = (seat: number) => props.players[(seat - (props.localSeat ?? 0) + 4) % 4]?.name ?? `玩家${seat + 1}`
const wins = computed(() => props.state.batches.flatMap(batch => batch.winners
  .filter(record => props.filterSeat == null || record.winner === props.filterSeat)
  .map(record => ({ record, source: batch.source }))).reverse())
const result = computed(() => props.state.roundResult)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="blood-flow-ledger-backdrop" :style="themePresentationCssVariables(themePresentationByName(themeName ?? 'jade'))" @click.self="$emit('close')">
      <section class="blood-flow-ledger" role="dialog" aria-modal="true" aria-label="血流公开流水">
        <header>
          <div><small>莲花麻将·血流</small><h2>{{ result ? '本局结束' : '公开流水' }}</h2></div>
          <button type="button" aria-label="关闭流水" @click="$emit('close')">×</button>
        </header>
        <div class="ledger-scroll">
          <table v-if="result">
            <thead><tr><th>玩家</th><th>胡牌</th><th>胡分</th><th>杠分</th><th>净分</th><th>排名</th></tr></thead>
            <tbody><tr v-for="(_, seat) in state.seats" :key="seat">
              <th>{{ name(seat) }}</th><td>{{ result.winCounts[seat] }}次</td><td>{{ result.winNet[seat] }}</td><td>{{ result.kongNet[seat] }}</td>
              <td>{{ result.endingScores[seat] - result.openingScores[seat] }}</td><td>{{ result.ranks[seat] }}</td>
            </tr></tbody>
          </table>
          <p v-if="state.status === 'interrupted'" role="status">对局中断，以下保留最后已确认的流水。</p>
          <p v-if="!wins.length" class="empty">{{ filterSeat == null ? '本局还没有胡牌记录' : `${name(filterSeat)}还没有胡牌记录` }}</p>
          <article v-for="{ record, source } in wins" :key="record.id" class="ledger-win" :data-win-record="record.id">
            <div class="record-heading"><b>{{ name(record.winner) }} · 第{{ record.ordinal }}次胡</b><span>{{ tileName(source.tile) }} · {{ source.kind === 'draw' ? '自摸' : `${name(source.seat)}供牌` }}</span></div>
            <BloodFlowWinCard :score="record.score" :amount="record.deltas[record.winner]" />
            <p class="record-payments">{{ record.deltas.map((n, seat) => n ? `${name(seat)} ${n > 0 ? '+' : ''}${n}` : '').filter(Boolean).join(' · ') }}</p>
          </article>
          <details v-if="result"><summary>杠分明细</summary>
            <p v-for="entry in result.ledger.filter(e => e.kind === 'kong')" :key="entry.id">
              {{ name(entry.actor) }} · {{ ({ discard: '直杠', added: '补杠', concealed: '暗杠', wind: '风杠' })[entry.kongKind] }} · {{ entry.deltas.join(' / ') }}
            </p>
          </details>
        </div>
        <footer v-if="result">
          <button v-if="!matchFinished" type="button" class="ledger-primary" @click="$emit('nextRound')">继续下一局</button>
          <strong v-else>本场已完成</strong>
          <button type="button" @click="$emit('returnToLobby')">返回大厅</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.blood-flow-ledger-backdrop { position: fixed; inset: 0; z-index: 180; display: grid; place-items: center; padding: 12px; background: rgba(0,0,0,.65); container-type: size; }
.blood-flow-ledger { width: min(700px, 96vw); max-height: 92dvh; display: flex; flex-direction: column; border: 1px solid var(--theme-border, #8a947c); border-radius: 16px; background: var(--theme-panel, #142424); color: var(--theme-text, #fff2d9); box-shadow: 0 20px 80px #0008; }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 18px; flex-shrink: 0; }
header { border-bottom: 1px solid #ffffff20; }
header small { opacity: .65; font-size: 11px; }
h2 { margin: 3px 0 0; font-size: 22px; }
button { padding: 7px 13px; border-radius: 8px; border: 1px solid #ffffff40; background: #ffffff0c; color: inherit; cursor: pointer; min-height: 36px; }
.ledger-primary { background: #e6c482; color: #1c2624; }
.ledger-scroll { min-height: 0; overflow: auto; padding: 12px 18px; overscroll-behavior: contain; }
table { border-collapse: collapse; width: 100%; font-size: 12px; margin-bottom: 15px; }
th, td { padding: 9px 5px; border-bottom: 1px solid #ffffff20; text-align: right; }
th:first-child { text-align: left; max-width: 120px; }
.ledger-win { margin-bottom: 16px; }
.record-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; justify-content: space-between; margin: 0 0 6px; font-size: 13px; }
.record-heading span, .record-payments { font-size: 11px; opacity: .72; }
.record-payments { margin: 5px 1px; }
.empty { text-align: center; opacity: .6; padding: 25px 0; }
summary { cursor: pointer; }
@container (max-height: 450px) { header, footer { padding: 7px 12px; } h2 { font-size: 16px; } .ledger-scroll { padding: 8px 12px; } }
</style>
