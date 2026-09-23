// 选项 4 止损阀：Jev 危险度信号检验（显式门控）。
//   $env:JEV_SIGNAL_RUN='1'; $env:JEV_BASE_URL='http://127.0.0.1:8300'
//   node node_modules/vitest/vitest.mjs run --dir scripts jev-signal-validate.test.ts
//
// 方法（预注册）：对 E4 hint 臂 30 场分析包里每个 seat0（Jev）弃牌决策：
//   - 用该场展示回放的 anchor+步骤流重建决策点公开局面（decisionState.replay.stepIndex 定位）；
//   - 向 serve 补问 noul：「座位0 现在打这张牌是否会立刻被任一对手胡牌」→ pDanger；
//   - 实现结果 realizedRon 从同场步骤流取（弃牌后紧邻的 win 步骤 from===0 且 tile 相同）。
// 判定（预注册 kill 阀）：AUC ≤ 0.55 → 选项 4 死，立即停；≥ 0.60 → 进融合 pilot；之间 → 边界报告。
// 产物 work/jev-signal-<stamp>/{samples.jsonl, metrics.json}。
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

interface Step {
  t: string; seat: number; tile?: string; kind?: string; from?: number | null
  wallLeft: number; scores?: number[]; sourceDiscards?: string[]
  state?: { hand?: string[]; melds?: unknown[]; discards?: string[]; score?: number }
}

function auc(scores: Array<{ p: number; pos: boolean }>): number {
  const sorted = [...scores].sort((a, b) => a.p - b.p)
  const nPos = sorted.filter((s) => s.pos).length
  const nNeg = sorted.length - nPos
  if (!nPos || !nNeg) return NaN
  let rankSum = 0
  sorted.forEach((s, i) => { if (s.pos) rankSum += i + 1 })
  // 同分用中秩修正（简化：忽略同分 tie 修正，样本连续概率下 tie 极少）
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg)
}

it.skipIf(process.env.JEV_SIGNAL_RUN !== '1')('Jev 危险度信号检验（选项 4 止损阀）', async () => {
  const baseUrl = process.env.JEV_BASE_URL ?? 'http://127.0.0.1:8300'
  const runDir = (process.env.JEV_SIGNAL_PACKS
    ?? 'work/jev-selfplay/2026-09-23-19-18-06-gpu-lora-pilot')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const outDir = `work/jev-signal-${stamp}`
  mkdirSync(outDir, { recursive: true })

  const packs = readdirSync(runDir)
    .filter((name) => /^analysis-hint-match\d+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(`${runDir}/${name}`, 'utf8')))
  expect(packs.length).toBeGreaterThan(0)

  const samples: Array<Record<string, unknown>> = []
  for (const payload of packs) {
    const decisions = payload.records.filter((r: { tag: string }) => r.tag === 'decision')
      .map((r: { value: unknown }) => r.value as Record<string, unknown>)
      .filter((d) => d.seat === 0 && d.source === 'model'
        && (d.choice as { known?: boolean })?.known
        && ((d.choice as { value?: { action?: { kind?: string } } }).value?.action?.kind === 'discard'))
    const states = new Map<string, Record<string, unknown>>()
    for (const r of payload.records.filter((r: { tag: string }) => r.tag === 'decisionState')) {
      const v = r.value as Record<string, unknown>
      states.set(v.id as string, v)
    }
    const rounds = new Map<number, Record<string, unknown>>()
    for (const round of payload.replay.rounds as Array<Record<string, unknown>>) {
      rounds.set(round.roundIndex as number, round)
    }
    for (const d of decisions) {
      const st = states.get(d.stateId as string)
      const rp = st?.replay as { roundIndex?: number; stepIndex?: number } | undefined
      if (!st || !rp) continue
      const round = rounds.get(rp.roundIndex as number)
      if (!round) continue
      const steps = (round.steps as Step[]) ?? []
      const idx = rp.stepIndex as number
      if (idx < 0 || idx > steps.length) continue
      // 重建公开局面：anchor + steps[0..idx)
      const anchor = round.anchor as {
        hands: string[][]; melds: unknown[][]; discards: string[][]; scores: number[]; wallLeft: number
      }
      const discards = anchor.discards.map((darr) => [...darr])
      const melds = anchor.melds.map((m) => [...m] as unknown[])
      let scores = [...anchor.scores]
      let wallLeft = anchor.wallLeft
      for (const step of steps.slice(0, idx)) {
        wallLeft = step.wallLeft
        if (step.scores) scores = [...step.scores]
        if (step.t === 'discard' && step.tile) discards[step.seat].push(step.tile)
        if (step.sourceDiscards && step.from !== undefined && step.from !== null) {
          discards[step.from] = [...step.sourceDiscards]
        }
        if (step.t === 'meld') {
          melds[step.seat].push({ kind: step.kind ?? '?', tile: step.tile, from: step.from })
        }
        if (step.state) {
          if (step.state.discards) discards[step.seat] = [...step.state.discards]
          if (step.state.melds) melds[step.seat] = [...step.state.melds] as unknown[]
        }
      }
      const action = (d.choice as { value: { action: { kind: string; tile?: string } } }).value.action
      const tile = action.tile
      if (!tile) continue
      // 实现结果：弃牌后紧邻的 win 步骤 from===0 且 tile 相同
      let realizedRon = false
      for (let j = idx; j < Math.min(steps.length, idx + 8); j += 1) {
        const s = steps[j]
        if (s.t === 'discard' && s.seat === 0) break
        if (s.t === 'win' && s.from === 0 && s.tile === tile) { realizedRon = true; break }
      }
      const hand = (st.hand as string[]) ?? []
      const body = {
        state: {
          mode: 'danger-probe-v1',
          hand,
          drawnTile: hand[(st.drawnTileIndex as number) ?? -1] ?? null,
          discards, melds, scores, wallLeft,
          jokers: round.jokerTiles ?? [], flipTile: round.flipTile ?? null,
          probeTile: tile,
          note: '座位0 即将打出 probeTile；仅依据公开信息判断是否会被立刻点炮',
        },
        model: process.env.JEV_MODEL ?? 'jev-latest',
        questions: {
          danger: {
            type: 'noul',
            instructions: '座位0 现在打出 probeTile 这张牌：是否会立刻被任一对手胡牌（点炮）？',
          },
        },
      }
      const res = await fetch(`${baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`serve HTTP ${res.status}`)
      const json = await res.json() as {
        answers?: { danger?: { noul?: number } }
      }
      const pDanger = json.answers?.danger?.noul
      if (typeof pDanger !== 'number') throw new Error('serve 未返回 danger.noul')
      samples.push({
        match: (payload.match as { id?: string })?.id, round: rp.roundIndex, step: idx,
        tile, pDanger, realizedRon, wallLeft,
      })
    }
  }
  writeFileSync(`${outDir}/samples.jsonl`, samples.map((s) => JSON.stringify(s)).join('\n') + '\n')

  const n = samples.length
  const pos = samples.filter((s) => s.realizedRon)
  const baseRate = pos.length / Math.max(1, n)
  const aucVal = auc(samples.map((s) => ({ p: s.pDanger as number, pos: s.realizedRon as boolean })))
  const buckets = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01]
    .slice(0, -1).map((lo, i) => {
      const hi = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01][i]
      const inside = samples.filter((s) => (s.pDanger as number) >= lo && (s.pDanger as number) < hi)
      const hits = inside.filter((s) => s.realizedRon).length
      return {
        range: `[${lo.toFixed(1)},${Math.min(hi, 1).toFixed(1)})`, n: inside.length,
        realizedRate: inside.length ? hits / inside.length : null,
        meanP: inside.length ? inside.reduce((a, s) => a + (s.pDanger as number), 0) / inside.length : null,
      }
    }).filter((b) => b.n > 0)
  const meanPRon = pos.length ? pos.reduce((a, s) => a + (s.pDanger as number), 0) / pos.length : null
  const meanPSafe = (n - pos.length)
    ? samples.filter((s) => !s.realizedRon).reduce((a, s) => a + (s.pDanger as number), 0) / (n - pos.length)
    : null
  const metrics = {
    n, realizedRon: pos.length, baseRate, auc: aucVal,
    meanPDangerGivenRon: meanPRon, meanPDangerGivenSafe: meanPSafe,
    buckets,
    killRule: 'AUC<=0.55 杀死选项4；>=0.60 进融合 pilot；之间=边界报告',
    verdict: Number.isNaN(aucVal) ? 'no-signal-data'
      : aucVal <= 0.55 ? 'KILL' : aucVal >= 0.6 ? 'PROCEED' : 'BORDERLINE',
  }
  writeFileSync(`${outDir}/metrics.json`, JSON.stringify(metrics, null, 2))
  console.log(JSON.stringify(metrics, null, 2))
  expect(n).toBeGreaterThan(100)
}, 7_200_000)
