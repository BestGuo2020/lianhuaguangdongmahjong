#!/usr/bin/env node
// 前后端 llmAnime 角色固定文案核对（`src/game/llm/animeCharacters.ts` ↔ `backend/app/game/anime_characters.py`）。
//
// 两处是各自独立的字面量：前端用 `ANIME_VOICE_KEYS`，后端用 `ANIME_VOICE_LINE_KEYS`，
// 各自只断言键集合与长度，**没有任何测试能发现两边文案不一致**（2026-09-19 核对时 132 条一致，
// 但那是人工同步的结果）。改动这批文案前后各跑一次，避免只改了一边。
//
// 用法：node scripts/check-anime-lines-sync.mjs
// 退出码：0 一致 / 1 不一致或读不到文件（backend/ 是独立仓库的 linked worktree，可能不存在）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FRONTEND = join(root, 'src/game/llm/animeCharacters.ts')
const BACKEND = join(root, 'backend/app/game/anime_characters.py')

const KEYS = [
  'chi', 'peng', 'gang', 'hu', 'zimo', 'qiangganghu',
  'hu-2', 'zimo-2', 'qiangganghu-2',
  'win-self-draw', 'win-discard', 'win-robbed-kong', 'loss', 'draw',
]

function read(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    console.error(`读不到 ${path}（backend 是独立仓库 worktree，缺失时请先 checkout）`)
    process.exit(1)
  }
}

function parseFrontend(source) {
  const out = {}
  let id = null
  for (const line of source.split(/\r?\n/)) {
    const head = line.match(/profile\('([a-z]+)'/)
    if (head) { id = head[1]; out[id] = {}; continue }
    if (!id) continue
    for (const m of line.matchAll(/(?:'([a-z0-9-]+)'|([a-z0-9]+)):\s*'([^']*)'/g)) {
      const key = m[1] ?? m[2]
      if (KEYS.includes(key)) out[id][key] = m[3]
    }
    if (/^\s*\}\),?\s*$/.test(line)) id = null
  }
  return out
}

function parseBackend(source) {
  const out = {}
  let id = null
  for (const line of source.split(/\r?\n/)) {
    const head = line.match(/_profile\('([a-z]+)'/)
    if (head) { id = head[1]; out[id] = {}; continue }
    if (!id) continue
    for (const m of line.matchAll(/([a-z0-9_]+)='([^']*)'/g)) {
      const key = m[1].replace(/_/g, '-')
      if (KEYS.includes(key)) out[id][key] = m[2]
    }
    if (/^\s*\),?\s*$/.test(line)) id = null
  }
  return out
}

const frontend = parseFrontend(read(FRONTEND))
const backend = parseBackend(read(BACKEND))
const ids = [...new Set([...Object.keys(frontend), ...Object.keys(backend)])].sort()

const missing = []
const diffs = []
for (const id of ids) {
  if (!frontend[id]) missing.push(`${id}: 前端缺该角色`)
  if (!backend[id]) missing.push(`${id}: 后端缺该角色`)
  for (const key of KEYS) {
    const a = frontend[id]?.[key]
    const b = backend[id]?.[key]
    if (a === undefined) missing.push(`${id}.${key}: 前端缺该槽位`)
    if (b === undefined) missing.push(`${id}.${key}: 后端缺该槽位`)
    if (a !== undefined && b !== undefined && a !== b) diffs.push({ id, key, frontend: a, backend: b })
  }
}

const count = (map) => Object.values(map).reduce((n, lines) => n + Object.keys(lines).length, 0)
console.log(`前端角色 ${Object.keys(frontend).length} / 条数 ${count(frontend)}`)
console.log(`后端角色 ${Object.keys(backend).length} / 条数 ${count(backend)}`)
console.log(`槽位缺失 ${missing.length} 处，文案不一致 ${diffs.length} 处`)
for (const item of missing) console.log(`  缺: ${item}`)
for (const item of diffs) console.log(`  不一致 ${item.id}.${item.key}\n    前端: ${item.frontend}\n    后端: ${item.backend}`)

if (missing.length || diffs.length) {
  console.error('llmAnime 固定文案前后端不一致：请同时修改 animeCharacters.ts 与 anime_characters.py')
  process.exit(1)
}
console.log('OK: llmAnime 固定文案前后端逐条一致')
