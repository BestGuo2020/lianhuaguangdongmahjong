<script setup lang="ts">
import { ref, watch } from 'vue'
import { readLlmConfig, writeLlmConfig, normalizeBaseUrl } from '../../game/llm/config'
import { testLlmConnection } from '../../game/llm/client'
import type { LlmControllerStats } from '../../game/llm/llmController'

const props = defineProps<{
  open: boolean
  messages: string[]
  stats: LlmControllerStats
}>()
const emit = defineEmits<{ close: [] }>()

const enabled = ref(false)
const baseUrl = ref('')
const apiKey = ref('')
const model = ref('')
const style = ref<'激进' | '稳健' | '话痨' | '高冷'>('稳健')
const savedMark = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

function load() {
  const { config, enabled: on } = readLlmConfig()
  enabled.value = on
  baseUrl.value = config.baseUrl
  apiKey.value = config.apiKey
  model.value = config.model
  style.value = config.style
  savedMark.value = false
  testResult.value = null
}

watch(() => props.open, (open) => { if (open) load() })

function save() {
  writeLlmConfig({
    enabled: enabled.value,
    baseUrl: baseUrl.value.trim(),
    apiKey: apiKey.value.trim(),
    model: model.value.trim() || 'deepseek-chat',
    style: style.value,
  })
  savedMark.value = true
  testResult.value = null
}

function clearKey() {
  apiKey.value = ''
  writeLlmConfig({ apiKey: '', enabled: false })
  savedMark.value = true
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    const url = normalizeBaseUrl(baseUrl.value.trim())
    testResult.value = await testLlmConnection({
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      model: model.value.trim() || 'deepseek-chat',
      style: style.value,
      timeoutMs: 8000,
    })
    if (testResult.value.ok && !url) testResult.value = { ok: false, message: 'baseUrl 非法（检查协议与地址，不支持带账号信息的链接）' }
  } finally {
    testing.value = false
  }
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
        单机人机的 AI 玩家可接入大模型决策（出牌/吃碰杠）。修改后<strong>刷新页面</strong>生效；
        Key 仅保存在本浏览器。联机房间由服务端配置，与此无关。
      </p>

      <label class="llm-row">
        <span>启用</span>
        <input v-model="enabled" type="checkbox" data-testid="llm-enabled">
      </label>
      <label class="llm-row">
        <span>Base URL</span>
        <input v-model="baseUrl" type="text" placeholder="https://api.deepseek.com/v1" data-testid="llm-base-url" spellcheck="false">
      </label>
      <label class="llm-row">
        <span>API Key</span>
        <input v-model="apiKey" type="password" autocomplete="off" placeholder="sk-…" data-testid="llm-api-key">
      </label>
      <label class="llm-row">
        <span>模型</span>
        <input v-model="model" type="text" placeholder="deepseek-chat" data-testid="llm-model" spellcheck="false">
      </label>
      <label class="llm-row">
        <span>风格</span>
        <select v-model="style" data-testid="llm-style">
          <option value="激进">激进</option>
          <option value="稳健">稳健</option>
          <option value="话痨">话痨</option>
          <option value="高冷">高冷</option>
        </select>
      </label>

      <div class="llm-actions">
        <button data-testid="llm-save" @click="save">保存</button>
        <button data-testid="llm-test" :disabled="testing" @click="testConnection">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button data-testid="llm-clear-key" @click="clearKey">清除 Key</button>
      </div>
      <p v-if="savedMark" class="llm-status ok">已保存（刷新页面后生效）</p>
      <p v-if="testResult" class="llm-status" :class="testResult.ok ? 'ok' : 'err'">
        {{ testResult.message }}
      </p>

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
  position: fixed; z-index: 100; top: 0; right: 0; bottom: 0; width: min(390px, 92vw);
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
.llm-row { display: grid; grid-template-columns: 84px 1fr; align-items: center; gap: 10px; margin: 9px 0; }
.llm-row span { color: #a6b5ad; }
.llm-row input, .llm-row select {
  min-width: 0; padding: 7px 9px; border: 1px solid rgba(213, 171, 84, .3); border-radius: 6px;
  background: rgba(5, 18, 13, .8); color: #e8dcc0;
}
.llm-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.llm-actions button {
  padding: 8px 14px; border: 1px solid #d0a64d; border-radius: 18px;
  background: transparent; color: #f3d27c; cursor: pointer; font-size: 12px;
}
.llm-actions button:disabled { opacity: .5; cursor: default; }
.llm-status { margin: 8px 0; }
.llm-status.ok { color: #9fce9f; }
.llm-status.err { color: #e79a9a; }
.llm-stats { margin-top: 16px; border-top: 1px solid rgba(211, 174, 87, .14); padding-top: 12px; }
.llm-stats h3 { margin: 0 0 4px; color: #8ca296; font-size: 12px; letter-spacing: .18em; }
.llm-messages { margin: 8px 0 0; padding: 0; list-style: none; }
.llm-messages li { margin: 5px 0; padding: 7px 10px; border-radius: 8px; background: rgba(211, 174, 87, .08); color: #e8dcc0; }
</style>
