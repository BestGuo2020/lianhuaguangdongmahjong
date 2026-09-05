<script setup lang="ts">
import { computed } from 'vue'
import type { GamePlayer } from '../../game/core/contracts/types'
import type { BloodFlowRoundResult } from '../../game/variants/lotus/bloodFlow/types'
import type { TableThemeName } from '../table/three/tableTheme'
import { animeAvatarForPlayer } from '../../game/core/presentation/animeAvatarPresentation'
import { defaultAvatarForSeat } from '../../game/core/presentation/avatar'
const props = defineProps<{ result: BloodFlowRoundResult; players: GamePlayer[]; localSeat: number; themeName: TableThemeName; final?: boolean;
  bubbles?: Record<number, { text: string; id: number }> }>()
const entries = computed(() => props.players.map(p => ({ ...p, total: props.result.endingScores[p.seat],
  net: props.result.endingScores[p.seat] - props.result.openingScores[p.seat], rank: props.result.ranks[p.seat] }))
  .sort((a,b) => props.final ? a.rank-b.rank || a.seat-b.seat : b.net-a.net || a.seat-b.seat))
const signed = (n: number) => `${n>0?'+':''}${n}`
const avatar = (p: GamePlayer) => props.themeName === 'llmAnime' ? animeAvatarForPlayer(p) : p.avatar || defaultAvatarForSeat(p.seat)
function fallback(event: Event, seat: number) { const img=event.target as HTMLImageElement; img.onerror=null; img.src=defaultAvatarForSeat(seat) }
</script>
<template>
  <div class="bf-result-players" :class="{ final }">
    <article v-for="p in entries" :key="p.seat" class="bf-result-player" :class="{ self:p.seat===localSeat, champion:final&&p.rank===1 }" :data-result-seat="p.seat">
      <span v-if="final" class="bf-rank">{{ p.rank }}<small>名</small></span>
      <img :src="avatar(p)" :alt="p.name" @error="fallback($event,p.seat)">
      <div class="bf-player-name"><b>{{ p.name }}</b><small v-if="p.seat===localSeat">本家</small></div>
      <strong class="bf-result-amount" :data-score-direction="(final?p.total:p.net)>0?'positive':(final?p.total:p.net)<0?'negative':'zero'">{{ final?p.total:signed(p.net) }}<small>分</small></strong>
      <p v-if="final" class="bf-player-facts">本场累计积分 · 最后一局 {{ signed(p.net) }}</p>
      <p v-else class="bf-player-facts">当前 {{ p.total }}分 · 胡 {{ result.winCounts[p.seat] }}次</p>
      <p v-if="!final" class="bf-player-facts">胡牌 {{ signed(result.winNet[p.seat]) }} · 杠牌 {{ signed(result.kongNet[p.seat]) }}</p>
      <blockquote v-if="bubbles?.[(p.seat-localSeat+4)%4]" class="bf-result-reaction">{{ bubbles[(p.seat-localSeat+4)%4].text }}</blockquote>
    </article>
  </div>
</template>
<style scoped>
.bf-result-players { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
.bf-result-player { position:relative; display:flex; flex-direction:column; align-items:center; gap:9px; padding:20px 10px 16px; min-width:0; border:1px solid var(--theme-border,#758e71); border-radius:14px; background:color-mix(in srgb,var(--theme-panel,#152a25) 90%,white); }
.bf-result-player.self { outline:2px solid var(--theme-accent,#e6c482); outline-offset:-2px; }
.bf-result-player.champion { background:linear-gradient(160deg,color-mix(in srgb,var(--theme-accent,#e6c482) 25%,transparent),transparent 70%); }
img { width:74px; height:74px; border-radius:12px; object-fit:cover; border:2px solid var(--theme-accent,#e6c482); }
.bf-player-name { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:4px; text-align:center; overflow-wrap:anywhere; }
.bf-player-name small { font-size:10px; border:1px solid currentColor; border-radius:4px; padding:1px 4px; opacity:.8; }
.bf-result-amount { font-size:clamp(22px,3vw,38px); font-variant-numeric:tabular-nums; white-space:nowrap; }
.bf-result-amount small { font-size:11px; margin-left:3px; }
[data-score-direction="positive"] { color:var(--theme-positive,#7addae); } [data-score-direction="negative"] { color:var(--theme-negative,#ffad9b); }
.bf-player-facts { margin:0; font-size:11px; opacity:.72; text-align:center; line-height:1.5; }
.bf-rank { font:800 28px Georgia,serif; color:var(--theme-accent,#e6c482); } .bf-rank small { font:12px sans-serif; margin-left:3px; }
.bf-result-reaction { margin:2px 0 0; border-top:1px solid var(--theme-border,#758e71); padding-top:10px; font-size:13px; line-height:1.5; text-align:center; }
@container (max-width:650px) { .bf-result-players { gap:6px; } .bf-result-player { padding:10px 5px; gap:5px; } img { width:44px; height:44px; } .bf-player-name { font-size:12px; } .bf-player-facts { font-size:10px; } .bf-result-amount { font-size:22px; } .bf-rank { font-size:20px; } }
</style>
