<script setup lang="ts">
// 对局回放列表：一行 = 一整场（玩法 / 场次 / 对局日期 / 位次 / 主题），提供「查看 / 导出 / 删除」。
// 底部提供保留策略（本机偏好）与全部清空。
import { computed, ref, watch } from 'vue'
import { formatMatchDate, formatRank, matchSubtitle } from '../../game/replay/format'
import { buildReplayExport, downloadReplayExport, replayExportFilename } from '../../game/replay/export'
import { REPLAY_KEEP_OPTIONS, readReplayKeepCount, saveReplayKeepCount } from '../../game/replay/preferences'
import type { ReplayStorage } from '../../game/replay/storage'
import type { ReplayMatch } from '../../game/replay/types'
import { tableThemeIdentity } from '../../theme/themeIdentity'
import { themePresentationByName } from '../../theme/themePresentation'

const props = defineProps<{
  open: boolean
  storage: ReplayStorage
  /** 本地存储可用（无 IndexedDB / 隐私模式 / 写入失败）。 */
  available: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  view: [matchId: string]
}>()

const matches = ref<ReplayMatch[]>([])
const loading = ref(false)
const busy = ref(false)
const hint = ref('')
const keepCount = ref(readReplayKeepCount())
let hintTimer: number | null = null

function flashHint(text: string) {
  hint.value = text
  if (hintTimer != null) globalThis.clearTimeout(hintTimer)
  hintTimer = globalThis.setTimeout(() => { hint.value = '' }, 2600) as unknown as number
}

async function reload() {
  loading.value = true
  matches.value = await props.storage.list()
  loading.value = false
}

watch(() => props.open, (open) => {
  if (open) {
    keepCount.value = readReplayKeepCount()
    void reload()
  }
}, { immediate: true })

async function removeMatch(match: ReplayMatch) {
  if (!window.confirm(`删除这场回放？${match.rulesetName} · ${match.matchName}（${formatMatchDate(match.startedAt)}）`)) return
  busy.value = true
  await props.storage.remove(match.id)
  await reload()
  busy.value = false
}

async function clearAll() {
  if (!window.confirm('清空全部对局回放？此操作不可恢复。')) return
  busy.value = true
  await props.storage.clearAll()
  await reload()
  busy.value = false
}

/** 导出该场牌谱（场次 + 各局事件流）为 JSON 文件。 */
async function exportMatch(match: ReplayMatch) {
  busy.value = true
  try {
    const rounds = await props.storage.loadRounds(match.id)
    if (!rounds.length) {
      flashHint('这场没有可导出的牌谱')
      return
    }
    const payload = buildReplayExport(match, rounds)
    const written = downloadReplayExport(payload, replayExportFilename(match, payload.exportedAt))
    flashHint(written ? `已导出 ${rounds.length} 局牌谱` : '当前环境不支持下载')
  } finally {
    busy.value = false
  }
}

async function changeKeepCount(event: Event) {
  const next = saveReplayKeepCount(Number((event.target as HTMLSelectElement).value))
  keepCount.value = next
  await props.storage.setMaxMatches(next)
  await reload()
  flashHint(`保留最近 ${next} 场`)
}

const themeLabel = (name: ReplayMatch['themeName']) => tableThemeIdentity(name).label
const themeAccent = (name: ReplayMatch['themeName']) => themePresentationByName(name).palette.accent
const hasMatches = computed(() => matches.value.length > 0)
</script>

<template>
  <Transition name="modal">
    <div v-if="open" class="result-backdrop replay-list-backdrop" data-testid="replay-list">
      <section class="result-card settlement-card replay-list-card">
        <h2>对局回放</h2>
        <p class="replay-list-note">
          仅保存在本机浏览器（IndexedDB），不上传服务器。
        </p>

        <p v-if="!available" class="replay-list-empty" data-testid="replay-unavailable">
          当前浏览器不支持本地回放存储（或存储被禁用），本机无法保存与查看回放。
        </p>
        <div v-else-if="loading" class="replay-list-empty">加载中…</div>
        <p v-else-if="!hasMatches" class="replay-list-empty" data-testid="replay-empty">
          暂无对局回放，单机对战打完后会自动记录。
        </p>

        <ul v-else class="replay-list" data-testid="replay-list-rows">
          <li v-for="match in matches" :key="match.id" class="replay-row">
            <span class="replay-row-theme" :style="{ '--replay-theme-accent': themeAccent(match.themeName) }" aria-hidden="true"></span>
            <div class="replay-row-main">
              <strong>{{ match.rulesetName }} · {{ match.matchName }}</strong>
              <span class="replay-row-sub">{{ matchSubtitle(match) }}</span>
            </div>
            <div class="replay-row-meta">
              <span class="replay-row-date">{{ formatMatchDate(match.startedAt) }}</span>
              <span class="replay-row-theme-name" :title="`对局使用主题：${themeLabel(match.themeName)}`">
                主题 {{ themeLabel(match.themeName) }}
              </span>
            </div>
            <div class="replay-row-rank" :class="`rank-${match.myRank ?? 'none'}`">
              {{ formatRank(match.myRank) }}
            </div>
            <div class="replay-row-actions">
              <button type="button" data-action-role="primary" @click="emit('view', match.id)">查看</button>
              <button type="button" data-action-role="secondary" data-testid="replay-export" :disabled="busy" @click="exportMatch(match)">导出</button>
              <button type="button" data-action-role="secondary" :disabled="busy" @click="removeMatch(match)">删除</button>
            </div>
          </li>
        </ul>

        <div class="replay-list-settings">
          <label>
            保留最近
            <select data-testid="replay-keep-count" :value="keepCount" @change="changeKeepCount">
              <option v-for="option in REPLAY_KEEP_OPTIONS" :key="option" :value="option">{{ option }} 场</option>
            </select>
          </label>
          <span class="replay-list-count">已存 {{ matches.length }} 场，超出自动删除最旧</span>
          <span v-if="hint" class="replay-list-hint" role="status" data-testid="replay-hint">{{ hint }}</span>
        </div>

        <div class="result-actions replay-list-actions">
          <button v-if="hasMatches" type="button" data-action-role="danger" :disabled="busy" @click="clearAll">清空全部</button>
          <button type="button" @click="emit('update:open', false)">关闭</button>
        </div>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.replay-list-backdrop { z-index: 210; }
.replay-list-card { width: min(820px, 95%); }
.replay-list-note { margin: 0 0 10px; color: var(--theme-text-muted); font-size: 12px; text-align: center; }
.replay-list-empty { padding: 22px 0; color: var(--theme-text-muted); font-size: 13px; text-align: center; }
.replay-list { display: grid; gap: 6px; max-height: min(50vh, 460px); margin: 0; padding: 2px; overflow: hidden auto; list-style: none; }
.replay-row {
  display: grid;
  grid-template-columns: 6px minmax(0, 1.4fr) minmax(0, 1fr) 46px auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 30%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--theme-panel-elevated) 62%, transparent);
}
.replay-row-theme { width: 6px; height: 34px; border-radius: 3px; background: var(--replay-theme-accent); }
.replay-row-main { display: grid; gap: 2px; min-width: 0; }
.replay-row-main strong { overflow: hidden; color: var(--theme-text); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.replay-row-sub { color: var(--theme-text-muted); font-size: 12px; }
.replay-row-meta { display: grid; gap: 2px; justify-items: start; min-width: 0; }
.replay-row-date { color: var(--theme-text); font-size: 12px; }
.replay-row-theme-name { overflow: hidden; color: var(--theme-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.replay-row-rank { color: var(--theme-text-muted); font-size: 15px; text-align: center; }
.replay-row-rank.rank-1 { color: var(--theme-accent); }
.replay-row-actions { display: flex; gap: 6px; }
.replay-row-actions button { padding: 5px 10px; border-radius: 7px; font-size: 12px; }
.replay-list-settings {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 10px 4px 0;
  color: var(--theme-text-muted);
  font-size: 12px;
}
.replay-list-settings select {
  margin-left: 4px;
  padding: 3px 6px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 6px;
  background: var(--theme-button);
  color: var(--theme-text);
  font: inherit;
}
.replay-list-hint { color: var(--theme-accent); }
.replay-list-actions { justify-content: space-between; }
@media (max-width: 720px) {
  .replay-row { grid-template-columns: 6px minmax(0, 1fr) auto; grid-template-areas: 'theme main actions' '. meta actions' '. rank actions'; }
  .replay-row-theme { grid-area: theme; }
  .replay-row-main { grid-area: main; }
  .replay-row-meta { grid-area: meta; }
  .replay-row-rank { grid-area: rank; text-align: left; }
  .replay-row-actions { grid-area: actions; }
}
</style>
