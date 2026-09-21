<script setup lang="ts">
// 对局回放列表：一行 = 一整场（玩法 / 场次 / 对局日期 / 位次 / 主题），提供「查看 / 导出 / 删除」。
// 底部提供保留策略（本机偏好）、全部清空，以及**导入**入口（牌谱与分析包各一个，§10.7）。
// AI 分析记录（方案 §9.2）：每行显示分析区状态（未开启／完整／部分缺失／已删除），
// 并提供「导出分析包」与「只删分析、保留牌谱」两个独立入口 —— 两者互不影响。
import { computed, ref, watch } from 'vue'
import { formatMatchDate, formatRank, gameModeLabel, matchSubtitle, replayVersionNotice } from '../../game/replay/format'
import { buildReplayExport, downloadReplayExport, replayExportFilename } from '../../game/replay/export'
import { importReplayFile } from '../../game/replay/importReplay'
import { REPLAY_KEEP_OPTIONS, readReplayKeepCount, saveReplayKeepCount } from '../../game/replay/preferences'
import {
  analysisExportFilename, analysisFormatReadable, buildAnalysisExport, downloadAnalysisExport,
} from '../../game/replay/analysis/export'
import { importAnalysisFile } from '../../game/replay/analysis/import'
import type { AnalysisStorage } from '../../game/replay/analysis/storage'
import { analysisAreaLabel, analysisHasRecords } from '../../game/replay/analysis/status'
import type { AnalysisAreaStatus } from '../../game/replay/analysis/types'
import type { ReplayStorage } from '../../game/replay/storage'
import type { ReplayMatch } from '../../game/replay/types'
import { tableThemeIdentity } from '../../theme/themeIdentity'
import { themePresentationByName } from '../../theme/themePresentation'

const props = defineProps<{
  open: boolean
  storage: ReplayStorage
  /** 本地存储可用（无 IndexedDB / 隐私模式 / 写入失败）。 */
  available: boolean
  /** 独立分析区（§9.2）；未接线（联机或旧调用方）时为 null，行内不显示分析入口。 */
  analysis?: AnalysisStorage | null
  /**
   * AI 分析记录开关（§9.2：默认关闭，由玩家在这里打开）。
   * 切换后**下一场生效**（当前这一场已经在录的会录完，中途换档只会让记录半途而废）。
   */
  analysisEnabled?: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:analysisEnabled': [value: boolean]
  view: [matchId: string]
}>()

const matches = ref<ReplayMatch[]>([])
const loading = ref(false)
const busy = ref(false)
const hint = ref('')
const keepCount = ref(readReplayKeepCount())
/** 每场的分析区状态：undefined = 还没有这个场的任何分析数据（旧录像或未开启）。 */
const analysisStatus = ref<Record<string, AnalysisAreaStatus>>({})
let hintTimer: number | null = null

function flashHint(text: string) {
  hint.value = text
  if (hintTimer != null) globalThis.clearTimeout(hintTimer)
  hintTimer = globalThis.setTimeout(() => { hint.value = '' }, 2600) as unknown as number
}

/**
 * AI 分析记录开关（§9.2）：只把玩家的意图交给宿主（App 持有会话与持久化），
 * 这里顺带回一句"下一场生效"，免得玩家以为没生效又去点。
 */
function toggleAnalysis(next: boolean) {
  emit('update:analysisEnabled', next)
  flashHint(next ? '已开启 AI 分析记录，下一场生效' : '已关闭 AI 分析记录，下一场生效')
}

async function reload() {  loading.value = true
  matches.value = await props.storage.list()
  const statuses: Record<string, AnalysisAreaStatus> = {}
  if (props.analysis?.available()) {
    for (const match of matches.value) statuses[match.id] = await props.analysis.status(match.id)
  }
  analysisStatus.value = statuses
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
  // §9.2：分析区不得比它引用的展示回放活得更久 ⇒ 删场次时同步删除分析数据
  // （不依赖"下一场结束时对账"，否则中途关页会留下悬空引用）。
  if (props.analysis?.available() && analysisStatus.value[match.id]) {
    await props.analysis.removeAnalysis(match.id)
  }
  await reload()
  busy.value = false
}

/** 只删分析、保留可观看回放（§9.2）：删除后明确失去哪些能力，且牌谱不受影响。 */
async function removeAnalysisOnly(match: ReplayMatch) {
  const status = analysisStatus.value[match.id]
  if (!status || status === 'deleted') return
  if (!window.confirm('删除这场对局的分析记录？牌谱（可观看回放）会保留；'
    + '删除后将失去决策前态、合法/策略候选、动作来源、LLM 请求与回答、计分流水与赛后精确复现能力，且不可恢复。')) return
  busy.value = true
  try {
    await props.analysis!.removeAnalysis(match.id)
    await reload()
    flashHint('已删除该场分析记录，牌谱仍可观看')
  } finally {
    busy.value = false
  }
}

async function clearAll() {
  if (!window.confirm('清空全部对局回放？此操作不可恢复。')) return
  busy.value = true
  await props.storage.clearAll()
  // 清空展示回放后，分析区按清单回收（§9.2/§9.4）
  if (props.analysis?.available()) await props.analysis.reconcileLifecycle([])
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

/**
 * 导出**自包含**分析包（§9.2、§9.3）：分析记录 + 被引用的配置 + 展示回放一起带走。
 * 页面只显示提示，不在客户端做"补齐" —— 缺什么就如实说缺什么。
 */
async function exportAnalysis(match: ReplayMatch) {
  busy.value = true
  try {
    const storage = props.analysis
    if (!storage?.available()) {
      flashHint('当前环境不支持分析区存储')
      return
    }
    const [read, rounds, configurations, status] = await Promise.all([
      storage.read(match.id), props.storage.loadRounds(match.id), storage.readConfigs(match.id), storage.status(match.id),
    ])
    if (!read.parts.length) {
      flashHint('这场没有分析记录可导出（未开启录制或已删除）')
      return
    }
    const readable = analysisFormatReadable(read.parts)
    if (!readable.readable) {
      // §9.5：版本不认识就明确拒绝，不按当前格式硬解（硬解会把新字段悄悄丢掉）
      flashHint(readable.reason ?? '分析区格式版本无法识别')
      return
    }
    const meta = read.meta
    const payload = buildAnalysisExport({
      match, rounds, parts: read.parts, configurations, status,
      ...(meta?.gaps ? { gaps: meta.gaps } : {}),
    })
    const written = downloadAnalysisExport(payload, analysisExportFilename(match, payload.exportedAt))
    flashHint(written
      ? `已导出分析包（${payload.manifest.recordsTotal} 条记录${payload.reproductionCapable ? '，可精确复现' : '，不完整／不可精确复现'}）`
      : '当前环境不支持下载')
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

/** 读取用户选中的文件，并把 input 清空（否则再选同一个文件不会触发 change）。 */
async function takeFile(event: Event): Promise<string | null> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = ''
  if (!file) return null
  try {
    return await file.text()
  } catch (error) {
    flashHint(`读取文件失败：${String(error instanceof Error ? error.message : error)}`)
    return null
  }
}

/** 导入牌谱（§10.7）：解析失败或引用不闭合时如实报错，不落库半份。 */
async function importReplayFromFile(event: Event) {
  const text = await takeFile(event)
  if (text === null) return
  busy.value = true
  try {
    const outcome = await importReplayFile(props.storage, text)
    await reload()
    if (!outcome.ok) {
      flashHint(`导入失败：${outcome.reason ?? '未知原因'}`)
      return
    }
    // 导入的牌谱没有分析记录 ⇒ 列表会显示「缺少决策分析记录」，提示里也说清
    const note = outcome.notes.length ? `（${outcome.notes.join('；')}）` : ''
    flashHint(`已导入牌谱：${outcome.match?.rulesetName ?? ''} ${outcome.rounds.length} 局${note}；该场没有分析记录`)
  } finally {
    busy.value = false
  }
}

/** 导入自包含分析包（§9.2）：包里带展示回放，本地没有该场时会一并补上。 */
async function importAnalysisFromFile(event: Event) {
  const storage = props.analysis
  if (!storage) return
  const text = await takeFile(event)
  if (text === null) return
  busy.value = true
  try {
    const outcome = await importAnalysisFile({ replay: props.storage, analysis: storage, text })
    await reload()
    if (!outcome.ok) {
      flashHint(`导入失败：${outcome.reason ?? '未知原因'}`)
      return
    }
    const note = outcome.notes.length ? `（${outcome.notes.join('；')}）` : ''
    flashHint(`已导入分析包：${outcome.writtenRecords} 条记录${outcome.wroteReplay ? '，并补上该场牌谱' : ''}${note}`)
  } finally {
    busy.value = false
  }
}

const themeLabel = (name: ReplayMatch['themeName']) => tableThemeIdentity(name).label
const themeAccent = (name: ReplayMatch['themeName']) => themePresentationByName(name).palette.accent
const hasMatches = computed(() => matches.value.length > 0)

/**
 * 行内分析状态文案（§9.2 的四态 + 旧录像）。
 * 判定规则在 `analysis/status.ts` 里（纯函数、有单测）：这里只负责取状态。
 */
function analysisLabel(match: ReplayMatch): string {
  return analysisAreaLabel(match, analysisStatus.value[match.id])
}

function hasAnalysisRecords(match: ReplayMatch): boolean {
  return analysisHasRecords(analysisStatus.value[match.id])
}

/** 牌谱版本提示（§9.5）：由更新版本写下的记录要明确说出来，不静默按旧规则渲染。 */
function versionNotice(match: ReplayMatch): string | null {
  return replayVersionNotice(match)
}

/** 隐藏的文件输入：导入牌谱 / 导入分析包（§10.7）。 */
const replayImportInput = ref<HTMLInputElement | null>(null)
const analysisImportInput = ref<HTMLInputElement | null>(null)
</script>

<template>
  <Transition name="modal">
    <div v-if="open" class="result-backdrop replay-list-backdrop" data-testid="replay-list">
      <section class="result-card settlement-card replay-list-card">
        <h2>对局回放</h2>
        <p class="replay-list-note">
          仅保存在浏览器，不上传服务器。
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
              <strong>
                <em class="replay-row-mode" :data-mode="match.gameMode">{{ gameModeLabel(match) }}</em>
                {{ match.rulesetName }} · {{ match.matchName }}
              </strong>
              <span class="replay-row-sub">{{ matchSubtitle(match) }}</span>
            </div>
            <div class="replay-row-meta">
              <span class="replay-row-date">{{ formatMatchDate(match.startedAt) }}</span>
              <span class="replay-row-theme-name" :title="`对局使用主题：${themeLabel(match.themeName)}`">
                主题 {{ themeLabel(match.themeName) }}
              </span>
              <span
                v-if="versionNotice(match)"
                class="replay-row-version"
                data-testid="replay-version-notice"
              >{{ versionNotice(match) }}</span>
              <span
                v-if="analysis"
                class="replay-row-analysis"
                :data-analysis-status="analysisStatus[match.id] ?? 'none'"
                data-testid="replay-analysis-status"
              >{{ analysisLabel(match) }}</span>
            </div>
            <div class="replay-row-rank" :class="`rank-${match.myRank ?? 'none'}`">
              {{ formatRank(match.myRank) }}
            </div>
            <div class="replay-row-actions">
              <button type="button" data-action-role="primary" @click="emit('view', match.id)">查看</button>
              <button type="button" data-action-role="secondary" data-testid="replay-export" :disabled="busy" @click="exportMatch(match)">导出</button>
              <button
                v-if="analysis"
                type="button"
                data-action-role="secondary"
                data-testid="replay-analysis-export"
                :disabled="busy || !hasAnalysisRecords(match)"
                @click="exportAnalysis(match)"
              >导出分析</button>
              <button
                v-if="analysis"
                type="button"
                data-action-role="secondary"
                data-testid="replay-analysis-remove"
                :disabled="busy || !hasAnalysisRecords(match)"
                @click="removeAnalysisOnly(match)"
              >删分析</button>
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
          <!-- AI 分析记录开关（§9.2）：本机保存、可在此导出；下一场生效，不需要刷新页面 -->
          <label v-if="analysis" class="replay-analysis-switch" title="把每场对局的决策与分析数据记在本机（不上传）。切换后下一场生效。">
            <input
              type="checkbox"
              data-testid="replay-analysis-enabled"
              :checked="analysisEnabled === true"
              :disabled="busy"
              @change="toggleAnalysis(($event.target as HTMLInputElement).checked)"
            />
            记录 AI 分析
          </label>
          <span class="replay-list-count">已存 {{ matches.length }} 场，超出自动删除最旧</span>
          <button
            type="button"
            data-action-role="light"
            data-testid="replay-import"
            :disabled="busy || !available"
            @click="replayImportInput?.click()"
          >导入牌谱</button>
          <button
            v-if="analysis"
            type="button"
            data-action-role="light"
            data-testid="replay-analysis-import"
            :disabled="busy || !analysis.available()"
            @click="analysisImportInput?.click()"
          >导入分析</button>
          <span v-if="hint" class="replay-list-hint" role="status" data-testid="replay-hint">{{ hint }}</span>
        </div>
        <!-- 视觉隐藏但保留在布局里：setInputFiles / 真实浏览器都能用 -->
        <input
          ref="replayImportInput"
          class="replay-import-input"
          type="file"
          accept="application/json,.json"
          data-testid="replay-import-input"
          @change="importReplayFromFile"
        />
        <input
          v-if="analysis"
          ref="analysisImportInput"
          class="replay-import-input"
          type="file"
          accept="application/json,.json"
          data-testid="replay-analysis-import-input"
          @change="importAnalysisFromFile"
        />

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
.replay-row-mode {
  margin-right: 5px;
  padding: 0 5px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 50%, transparent);
  border-radius: 4px;
  color: var(--theme-text-muted);
  font-size: 10px;
  font-style: normal;
  vertical-align: 1px;
}
.replay-row-mode[data-mode="remote"] { border-color: color-mix(in srgb, var(--theme-accent) 60%, transparent); color: var(--theme-accent); }
.replay-row-sub { color: var(--theme-text-muted); font-size: 12px; }
.replay-row-meta { display: grid; gap: 2px; justify-items: start; min-width: 0; }
.replay-row-date { color: var(--theme-text); font-size: 12px; }
.replay-row-theme-name { overflow: hidden; color: var(--theme-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
/* 牌谱版本提示（§9.5）：更新版本写下的记录，明确提示而不是静默按旧规则渲染 */
.replay-row-version { color: #e0a94a; font-size: 11px; }
/* 分析区状态（§9.2）：用颜色区分四态，避免"未开启"与"缺失"看起来一样 */
.replay-row-analysis { color: var(--theme-text-muted); font-size: 11px; }
.replay-row-analysis[data-analysis-status="complete"] { color: var(--theme-accent); }
.replay-row-analysis[data-analysis-status="partial"] { color: #e0a94a; }
.replay-row-analysis[data-analysis-status="deleted"],
.replay-row-analysis[data-analysis-status="missing"],
.replay-row-analysis[data-analysis-status="none"] { color: var(--theme-text-muted); }
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
  /* 同控制条：全局 color-scheme 是 only light，需显式给深色弹层配色。 */
  color-scheme: dark;
}
.replay-list-settings select option {
  background-color: var(--theme-panel, #0a231a);
  color: var(--theme-text, #f8f3df);
}
/* AI 分析记录开关（§9.2）：与控制条同一行，勾选态用主题强调色 */
.replay-analysis-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.replay-analysis-switch input {
  width: 15px;
  height: 15px;
  accent-color: var(--theme-accent, #e6c482);
  cursor: pointer;
}
.replay-analysis-switch input:disabled { cursor: default; }
.replay-list-hint { color: var(--theme-accent); }
/* 导入用的隐藏文件输入：不用 display:none —— 那样 .click() 与自动化都不可靠 */
.replay-import-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}
.replay-list-settings button {
  padding: 4px 10px;
  border-radius: 7px;
  font-size: 12px;
}
.replay-list-actions {
  /* 居中排列（与结算卡片一致）：贴到内容区左右边缘时，直角按钮会视觉上"戳出"卡片圆角边框。 */
  justify-content: center;
  gap: 14px;
  margin: 16px 8px 0;
}
@media (max-width: 720px) {
  .replay-row { grid-template-columns: 6px minmax(0, 1fr) auto; grid-template-areas: 'theme main actions' '. meta actions' '. rank actions'; }
  .replay-row-theme { grid-area: theme; }
  .replay-row-main { grid-area: main; }
  .replay-row-meta { grid-area: meta; }
  .replay-row-rank { grid-area: rank; text-align: left; }
  .replay-row-actions { grid-area: actions; }
}
</style>
