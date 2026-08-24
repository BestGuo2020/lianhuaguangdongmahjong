<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  LLM_DECISION_TIMEOUT_MS, PROVIDER_TEMPLATES, emptyLlmSettings, normalizeBaseUrl, newPresetId, parseLlmSettingsJson, readLlmSettings, saveLlmSettings, serializeLlmSettings,
  type LlmProviderPreset, type LlmSettings,
} from '../../game/llm/config'
import { defaultNicknameFor } from '../../game/llm/persona'
import { testLlmConnection } from '../../game/llm/client'
import type { LlmControllerStats } from '../../game/llm/llmController'

const props = defineProps<{
  open: boolean
  messages: string[]
  stats: LlmControllerStats
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

/** 工作副本（打开时从存储载入；保存时整体写回） */
const settings = ref<LlmSettings>(emptyLlmSettings())
const selectedId = ref<string | null>(null)
const templateIndex = ref(0)
const savedMark = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const transferStatus = ref<{ ok: boolean; message: string } | null>(null)

const MAX_IMPORT_BYTES = 1024 * 1024

const selected = computed(() => settings.value.presets.find((preset) => preset.id === selectedId.value) ?? null)
const seatLabels = ['上家（左）', '对家（上）', '下家（右）']

function load() {
  settings.value = readLlmSettings()
  selectedId.value = settings.value.activeId ?? settings.value.presets[0]?.id ?? null
  savedMark.value = false
  testResult.value = null
  transferStatus.value = null
}

watch(() => props.open, (open) => { if (open) load() })

function save() {
  // 清理空预置（无 baseUrl/key/model 的残壳）
  settings.value.presets = settings.value.presets.filter((preset) => preset.baseUrl || preset.apiKey || preset.model)
  if (!settings.value.activeId || !settings.value.presets.some((preset) => preset.id === settings.value.activeId)) {
    settings.value.activeId = settings.value.presets[0]?.id ?? null
  }
  saveLlmSettings(settings.value)
  savedMark.value = true
  testResult.value = null
  emit('saved')
}

function addFromTemplate() {
  const chosen = templateIndex.value
  const template = PROVIDER_TEMPLATES[chosen] ?? PROVIDER_TEMPLATES[PROVIDER_TEMPLATES.length - 1]
  const isCustomTemplate = chosen >= PROVIDER_TEMPLATES.length - 1
  const preset: LlmProviderPreset = {
    id: newPresetId(),
    name: template.name,
    baseUrl: template.baseUrl,
    apiKey: '',
    model: template.model,
    style: '稳健',
    timeoutMs: LLM_DECISION_TIMEOUT_MS,
    ttsVoiceKey: 'auto',
    ...(isCustomTemplate ? { fromCustomTemplate: true } : {}),
  }
  settings.value.presets.push(preset)
  selectedId.value = preset.id
  if (!settings.value.activeId) settings.value.activeId = preset.id
  savedMark.value = false
}

function removeSelected() {
  const target = selected.value
  if (!target) return
  settings.value.presets = settings.value.presets.filter((preset) => preset.id !== target.id)
  if (settings.value.activeId === target.id) {
    settings.value.activeId = settings.value.presets[0]?.id ?? null
  }
  settings.value.seatIds = settings.value.seatIds.map((seatId) => (seatId === target.id ? null : seatId))
  selectedId.value = settings.value.activeId
}

function clearKey() {
  if (selected.value) selected.value.apiKey = ''
  savedMark.value = true
}

async function testConnection() {
  const preset = selected.value
  if (!preset) return
  testing.value = true
  testResult.value = null
  try {
    const url = normalizeBaseUrl(preset.baseUrl)
    const result = await testLlmConnection({
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: preset.model,
      style: preset.style,
      timeoutMs: preset.timeoutMs,
    })
    testResult.value = result.ok && !url ? { ok: false, message: 'baseUrl 非法（检查协议与地址，不支持带账号信息的链接）' } : result
  } finally {
    testing.value = false
  }
}

function exportSettingsJson() {
  const blob = new Blob([serializeLlmSettings(settings.value)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `lianhua-llm-settings-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
  transferStatus.value = { ok: true, message: 'JSON 已导出（不含 API Key）' }
}

function chooseImportFile() {
  importInput.value?.click()
}

async function importSettingsJson(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  transferStatus.value = null
  try {
    if (!file.name.toLowerCase().endsWith('.json')) throw new Error('请选择 .json 文件')
    if (file.size > MAX_IMPORT_BYTES) throw new Error('JSON 文件不能超过 1 MB')
    settings.value = parseLlmSettingsJson(await file.text(), settings.value)
    selectedId.value = settings.value.activeId ?? settings.value.presets[0]?.id ?? null
    savedMark.value = false
    testResult.value = null
    transferStatus.value = { ok: true, message: '已导入，请检查配置后点击“保存”' }
  } catch (error) {
    transferStatus.value = {
      ok: false,
      message: error instanceof Error ? error.message : '导入失败',
    }
  }
}

function presetName(id: string | null): string {
  return settings.value.presets.find((preset) => preset.id === id)?.name ?? '跟随默认'
}
</script>

<template>
  <Teleport to="body">
    <section v-if="props.open" class="llm-panel" aria-label="AI 设置">
      <header>
        <h2>AI 大模型</h2>
        <button class="llm-close" aria-label="关闭" data-testid="llm-close" @click="emit('close')">✕</button>
      </header>

      <p class="llm-hint">
        单机人机的 AI 玩家可接入大模型决策（出牌/吃碰杠），可添加多个供应商并<b>给不同座位分配不同模型</b>。
        <b>联机房间不走这里：</b>空位大模型由<b>服务端注册的提供商</b>提供（建房时在房间面板为每个空位选择，
        如「大肥鱼（激进）」，key 全在服务端），无需在本页填写 Key。
        修改后保存，开局时生效；开局后不能继续修改。Key 仅保存在本浏览器、仅浏览器直连所填供应商。
      </p>

      <label class="llm-row">
        <span>启用</span>
        <input v-model="settings.enabled" type="checkbox" data-testid="llm-enabled">
      </label>

      <!-- 供应商列表 -->
      <div class="llm-provider-list" data-testid="llm-provider-list">
        <button
          v-for="preset in settings.presets" :key="preset.id"
          class="llm-provider-item" :class="{ active: preset.id === selectedId, default: preset.id === settings.activeId }"
          data-testid="llm-provider-item" @click="selectedId = preset.id"
        >
          <b>{{ preset.name }}</b>
          <span>{{ preset.model || preset.baseUrl || '（未配置）' }}</span>
        </button>
        <div class="llm-provider-add">
          <select v-model.number="templateIndex" data-testid="llm-template" aria-label="添加模板">
            <option v-for="(template, index) in PROVIDER_TEMPLATES" :key="template.name" :value="index">{{ template.name }}</option>
          </select>
          <button data-testid="llm-add" @click="addFromTemplate">＋添加</button>
        </div>
      </div>

      <!-- 所选供应商编辑 -->
      <template v-if="selected">
        <div class="llm-seat-assign">
          <p class="llm-sub-title">座位分配（谁用哪个模型 + 什么风格）</p>
          <button
            class="llm-seat-row" :class="{ chosen: settings.activeId === selected.id }"
            data-testid="llm-seat-default" @click="settings.activeId = selected.id"
          >
            <span>默认预置：</span><b>{{ settings.activeId === selected.id ? '✓ ' + selected.name : presetName(settings.activeId) }}</b>
          </button>
          <label v-for="(label, index) in seatLabels" :key="label" class="llm-seat-row">
            <span>{{ label }}：</span>
            <div class="llm-seat-picks">
              <select v-model="settings.seatIds[index + 1]" data-testid="llm-seat" @click.stop>
                <option :value="null">跟随默认（{{ presetName(settings.activeId) }}）</option>
                <option v-for="preset in settings.presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
              </select>
              <select v-model="settings.seatStyles[index + 1]" data-testid="llm-seat-style" @click.stop>
                <option :value="null">风格：跟随</option>
                <option value="激进">激进</option>
                <option value="稳健">稳健</option>
                <option value="话痨">话痨</option>
                <option value="高冷">高冷</option>
              </select>
            </div>
          </label>
        </div>

        <label class="llm-row">
          <span>名称</span>
          <input v-model="selected.name" type="text" data-testid="llm-name">
        </label>
        <label class="llm-row">
          <span>昵称</span>
          <input
            v-model="selected.nickname" type="text" data-testid="llm-nickname"
            :placeholder="`默认：${defaultNicknameFor(selected.baseUrl, selected.name)}（对局显示：昵称（策略））`"
          >
        </label>
        <label v-if="selected.fromCustomTemplate" class="llm-row">
          <span>头像文件夹</span>
          <input
            v-model="selected.avatarFolder" type="text" data-testid="llm-avatar-folder"
            placeholder="如 gpt；留空=自动（custom）"
          >
        </label>
        <label class="llm-row">
          <span>Base URL</span>
          <input v-model="selected.baseUrl" type="text" placeholder="https://api.deepseek.com/v1" data-testid="llm-base-url" spellcheck="false">
        </label>
        <label class="llm-row">
          <span>API Key</span>
          <input v-model="selected.apiKey" type="password" autocomplete="off" placeholder="sk-…" data-testid="llm-api-key">
        </label>
        <label class="llm-row">
          <span>模型</span>
          <input v-model="selected.model" type="text" placeholder="deepseek-v4-flash" data-testid="llm-model" spellcheck="false">
        </label>
        <label class="llm-row">
          <span>风格</span>
          <select v-model="selected.style" data-testid="llm-style">
            <option value="激进">激进</option>
            <option value="稳健">稳健</option>
            <option value="话痨">话痨</option>
            <option value="高冷">高冷</option>
          </select>
        </label>
        <label class="llm-row">
          <span>单机音色</span>
          <select v-model="selected.ttsVoiceKey" data-testid="llm-tts-voice">
            <option value="auto">自动识别模型</option>
            <option value="deepseek">DeepSeek · 4196</option>
            <option value="relay_gpt">GPT · 4194</option>
            <option value="default">策略默认音色</option>
          </select>
        </label>

        <div class="llm-actions">
          <button data-testid="llm-remove" @click="removeSelected">删除该供应商</button>
        </div>
      </template>

      <div class="llm-actions">
        <button data-testid="llm-save" @click="save">保存</button>
        <button data-testid="llm-test" :disabled="!selected || testing" @click="testConnection">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button data-testid="llm-clear-key" :disabled="!selected" @click="clearKey">清除当前 Key</button>
        <button data-testid="llm-export-json" :disabled="settings.presets.length === 0" @click="exportSettingsJson">导出 JSON</button>
        <button data-testid="llm-import-json" @click="chooseImportFile">导入 JSON</button>
        <input
          ref="importInput" class="llm-import-input" type="file" accept="application/json,.json"
          data-testid="llm-import-file" @change="importSettingsJson"
        >
      </div>
      <p class="llm-transfer-hint">导出文件不包含 API Key；导入后需检查并点击保存。</p>
      <p v-if="savedMark" class="llm-status ok">已保存（开局时生效）</p>
      <p v-if="testResult" class="llm-status" :class="testResult.ok ? 'ok' : 'err'">{{ testResult.message }}</p>
      <p v-if="transferStatus" class="llm-status" :class="transferStatus.ok ? 'ok' : 'err'">{{ transferStatus.message }}</p>

      <div class="llm-stats">
        <h3>本局 AI 统计</h3>
        <p>请求 {{ stats.requests }} · 成功 {{ stats.successes }} · 回退 {{ stats.fallbacks }} · 吐槽 {{ stats.messages }}</p>
        <ul v-if="messages.length" class="llm-messages">
          <li v-for="(message, index) in [...messages].reverse()" :key="index">{{ message }}</li>
        </ul>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.llm-panel {
  position: fixed; z-index: 100; top: 0; right: 0; bottom: 0; width: min(410px, 94vw);
  padding: 26px 24px; overflow: auto; border-left: 1px solid #997439;
  background: linear-gradient(160deg, #102b23, #071510 65%);
  box-shadow: -22px 0 60px rgba(0, 0, 0, .65);
  color: #d0c39e; font-size: 13px;
}
.llm-panel header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.llm-panel h2 { margin: 0; color: #e5d5ad; font-size: 18px; letter-spacing: .08em; }
.llm-close { border: 0; background: transparent; color: #8ca296; font-size: 16px; cursor: pointer; }
.llm-hint { color: #9db0a6; line-height: 1.6; }
.llm-hint strong { color: #f3d27c; }
.llm-hint b { color: #e5d5ad; }
.llm-row { display: grid; grid-template-columns: 84px 1fr; align-items: center; gap: 10px; margin: 9px 0; }
.llm-row > span { color: #a6b5ad; }
.llm-row input, .llm-row select, .llm-seat-row select {
  min-width: 0; padding: 7px 9px; border: 1px solid rgba(213, 171, 84, .3); border-radius: 6px;
  background: rgba(5, 18, 13, .8); color: #e8dcc0;
}
.llm-provider-list { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
.llm-provider-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 10px; border: 1px solid rgba(213, 171, 84, .18); border-radius: 8px;
  background: transparent; color: #d0c39e; cursor: pointer; text-align: left;
}
.llm-provider-item b { color: #e8dcc0; }
.llm-provider-item span { max-width: 55%; overflow: hidden; font-size: 11px; color: #8ca296; text-overflow: ellipsis; white-space: nowrap; }
.llm-provider-item.active { border-color: rgba(225, 189, 85, .6); background: rgba(211, 174, 87, .08); }
.llm-provider-item.default::after { content: '默认'; margin-left: 6px; color: #f3d27c; font-size: 10px; }
.llm-provider-add { display: flex; gap: 8px; }
.llm-provider-add select { flex: 1; min-width: 0; padding: 7px 9px; border: 1px solid rgba(213, 171, 84, .3); border-radius: 6px; background: rgba(5, 18, 13, .8); color: #e8dcc0; }
.llm-provider-add button, .llm-actions button {
  padding: 8px 14px; border: 1px solid #d0a64d; border-radius: 18px;
  background: transparent; color: #f3d27c; cursor: pointer; font-size: 12px;
}
.llm-seat-assign { margin: 10px 0; padding: 10px; border: 1px solid rgba(213, 171, 84, .18); border-radius: 8px; }
.llm-sub-title { margin: 0 0 6px; color: #8ca296; font-size: 11px; letter-spacing: .14em; }
.llm-seat-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 6px 0; }
.llm-seat-row.chosen { color: #f3d27c; }
/* 默认预置是个 button：覆盖浏览器默认亮色背景，保持与面板暗色一致 */
button.llm-seat-row {
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #d0c39e;
  text-align: left;
  cursor: pointer;
}
button.llm-seat-row:hover { background: rgba(211, 174, 87, .08); }
.llm-seat-picks { display: flex; gap: 6px; min-width: 0; flex: 1; justify-content: flex-end; }
.llm-seat-picks select { max-width: 55%; }
.llm-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.llm-actions button:disabled { opacity: .5; cursor: default; }
.llm-import-input { display: none; }
.llm-transfer-hint { margin: 7px 0 0; color: #84978d; font-size: 11px; line-height: 1.5; }
.llm-status { margin: 8px 0; }
.llm-status.ok { color: #9fce9f; }
.llm-status.err { color: #e79a9a; }
.llm-stats { margin-top: 16px; border-top: 1px solid rgba(211, 174, 87, .14); padding-top: 12px; }
.llm-stats h3 { margin: 0 0 4px; color: #8ca296; font-size: 12px; letter-spacing: .18em; }
.llm-messages { margin: 8px 0 0; padding: 0; list-style: none; }
.llm-messages li { margin: 5px 0; padding: 7px 10px; border-radius: 8px; background: rgba(211, 174, 87, .08); color: #e8dcc0; }
</style>
