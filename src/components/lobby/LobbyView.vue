<script setup lang="ts">
import { computed, ref } from 'vue'
import RoomPanel from './RoomPanel.vue'
import GameSettingsSummary from './GameSettingsSummary.vue'
import LobbyDialog from './LobbyDialog.vue'
import MatchTypePicker from './MatchTypePicker.vue'
import RuleVariantPicker from './RuleVariantPicker.vue'
import type { GameMode } from '../../game/core/contracts/activeGamePort'
import type { MatchType } from '../../game/core/contracts/types'
import { getRuleVariant, type RuleVariant } from '../../game/core/rules/ruleVariants'
import type { LlmProviderInfo, LlmSeatRequest, RoomMeta, RoomSeatState } from '../../game/online/api/roomApi'
import type { StoredSession } from '../../game/online/session/remoteSessionStore'
import AnimeCharacterPicker from '../llm/AnimeCharacterPicker.vue'
import { resolveAnimeCharacter, type CharacterId } from '../../game/llm/animeCharacters'
import { animeCharacterAvatarUrl } from '../../game/llm/animeCharacterPreference'
import type { TableThemeName } from '../table/three/tableTheme'

interface Props {
  gameMode: GameMode
  selectedMatch: MatchType
  selectedRule: RuleVariant
  matchName: string
  storedSession: StoredSession | null
  roomId: string
  nicknameInput: string
  joinCode: string
  animeCharacterId: CharacterId
  tableThemeName: TableThemeName
  roomMeta: RoomMeta | null
  sessionStatus: string
  sessionError: string
  roomTimeLimit: number | null
  roomSeats: Array<RoomSeatState | null>
  /** 房主请求的空座 AI 补位是否使用大模型 */
  llmEnabled: boolean
  /** 实际生效（请求 && 服务端配置齐全） */
  effectiveLlmEnabled: boolean
  /** 服务端是否配置了大模型 */
  llmAvailable: boolean
  /** 服务端注册的提供商（不含 key） */
  llmProviders: Array<LlmProviderInfo>
  mySeat: number
  isCreator: boolean
  allOccupiedReady: boolean
  matchStarting: boolean
  copied: boolean
  leaving: boolean
  closing: boolean
  wakuAuthenticated: boolean
  wakuAccountName: string
  wakuAuthLoading: boolean
  wakuAuthError: string
  /** 可按产品策略隐藏联机入口；当前莲花旧版也支持联机。 */
  singlePlayerOnly?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:gameMode': [value: GameMode]
  'update:selectedMatch': [value: MatchType]
  'update:selectedRule': [value: RuleVariant]
  'update:nicknameInput': [value: string]
  'update:joinCode': [value: string]
  'update:animeCharacterId': [value: CharacterId]
  startLocal: []
  createRoom: [payload: { llmEnabled: boolean }]
  joinRoom: []
  resumeSession: []
  copyRoom: []
  toggleReady: []
  startRemote: [payload: { llmSeats: Array<LlmSeatRequest> }]
  leaveRoom: []
  closeRoom: []
  openStats: []
  openRules: []
  wakuLogin: []
  wakuLogout: []
}>()

type DialogName = 'create' | 'join' | 'match' | 'rule' | 'character' | null
const dialog = ref<DialogName>(null)
const pickerReturn = ref<'create' | null>(null)
/** 联机房间专用开关：只控制服务端 LLM，与单机 localStorage provider 完全独立。 */
const remoteLlmEnabled = ref(false)

const matchOption = computed(() => props.selectedMatch === 'east'
  ? { name: '东风场', description: '一场 4 局' }
  : { name: '半庄场', description: '一场 8 局' })
const ruleOption = computed(() => getRuleVariant(props.selectedRule))
const currentCharacter = computed(() => resolveAnimeCharacter(props.animeCharacterId))
const currentCharacterAvatar = computed(() => animeCharacterAvatarUrl(props.animeCharacterId))
const dialogTitle = computed(() => ({
  create: '创建房间',
  join: '加入房间',
  match: '选择场次',
  rule: '选择规则玩法',
  character: '本家形象',
}[dialog.value ?? 'create']))

function openPicker(name: 'match' | 'rule', fromCreate = false) {
  pickerReturn.value = fromCreate ? 'create' : null
  dialog.value = name
}

function closePicker() {
  dialog.value = pickerReturn.value
  pickerReturn.value = null
}

function selectMatch(value: MatchType) {
  emit('update:selectedMatch', value)
  closePicker()
}

function selectRule(value: RuleVariant) {
  emit('update:selectedRule', value)
  closePicker()
}

function selectCharacter(value: CharacterId) {
  emit('update:animeCharacterId', value)
  dialog.value = null
}

function confirmCreate() {
  dialog.value = null
  emit('createRoom', {
    llmEnabled: remoteLlmEnabled.value && props.roomMeta?.llmAvailable === true,
  })
}

function openCreateDialog() {
  remoteLlmEnabled.value = false
  dialog.value = 'create'
}

function confirmJoin() {
  dialog.value = null
  emit('joinRoom')
}

function viewRules() {
  dialog.value = null
  pickerReturn.value = null
  emit('openRules')
}

function closeDialog() {
  if (dialog.value === 'match' || dialog.value === 'rule') {
    closePicker()
    return
  }
  dialog.value = null
}

function toggleWakuDemoAuth() {
  if (props.wakuAuthenticated) emit('wakuLogout')
  else emit('wakuLogin')
}
</script>

<template>
  <section class="lobby">
    <p class="eyebrow">LIANHUA MAHJONG COLLECTIONS</p>
    <h1>莲花<span>广麻</span></h1>
    <p class="subtitle">一款莲花县特有的地方麻将游戏玩法</p>
    <div class="waku-account" :class="{ authenticated: wakuAuthenticated }">
      <div>
        <b>{{ wakuAuthenticated ? (wakuAccountName || 'WakuDemo 玩家') : 'WakuDemo 账号' }}</b>
        <small>{{ wakuAuthenticated ? '已安全登录' : '登录后关联平台身份' }}</small>
      </div>
      <button
        type="button"
        :disabled="wakuAuthLoading"
        @click="toggleWakuDemoAuth"
      >{{ wakuAuthLoading ? '处理中…' : (wakuAuthenticated ? '退出' : '登录') }}</button>
    </div>
    <p v-if="wakuAuthError" class="waku-auth-error" role="alert">{{ wakuAuthError }}</p>
    <button v-if="storedSession && !roomId" class="continue-session" @click="$emit('resumeSession')">
      ⏵ 继续对局<template v-if="storedSession.roomId">（房间 {{ storedSession.roomId }}）</template>
    </button>
    <div class="mode-selector" role="radiogroup" aria-label="游戏模式">
      <button :class="{ active: gameMode === 'local' }" role="radio" :aria-checked="gameMode === 'local'" @click="$emit('update:gameMode', 'local')"><b>单机对战</b><span>与 AI 同桌</span></button>
      <button v-if="!singlePlayerOnly" :class="{ active: gameMode === 'remote' }" role="radio" :aria-checked="gameMode === 'remote'" @click="$emit('update:gameMode', 'remote')"><b>联机对战</b><span>创建或加入房间</span></button>
    </div>
    <template v-if="gameMode === 'local'">
      <GameSettingsSummary
        :match-name="matchOption.name"
        :match-description="matchOption.description"
        :rule-name="ruleOption.name"
        :rule-description="ruleOption.highlights.slice(0, 2).join(' · ')"
        @select-match="openPicker('match')"
        @select-rule="openPicker('rule')"
      />
      <button
        v-if="tableThemeName === 'llmAnime'"
        type="button"
        class="character-shortcut"
        @click="dialog = 'character'"
      >
        <img :src="currentCharacterAvatar" alt="" aria-hidden="true">
        <span class="character-shortcut-label">本家形象</span>
        <b>{{ currentCharacter.label }}</b>
        <span class="character-shortcut-chevron">›</span>
      </button>
      <button class="start-button" @click="$emit('startLocal')"><b>开始{{ matchOption.name }}</b><span>{{ ruleOption.name }} · 四人对局</span></button>
    </template>

    <div v-else class="remote-lobby">
      <label class="remote-field">
        <span>昵称</span>
        <input
          :value="nicknameInput"
          maxlength="12"
          placeholder="输入昵称"
          @input="$emit('update:nicknameInput', ($event.target as HTMLInputElement).value)"
          @keyup.enter="dialog = 'create'"
        />
      </label>
      <p v-if="roomMeta && !roomId" class="room-meta-note" role="status">
        剩余房间 <b>{{ roomMeta.max - roomMeta.active }}</b> / {{ roomMeta.max }}
        <template v-if="roomMeta.llmAvailable"> · <span class="room-meta-llm">服务器已启用大模型</span></template>
      </p>
      <div v-if="!roomId" class="remote-entry-actions">
        <button class="remote-create" :disabled="!nicknameInput.trim() || sessionStatus === 'creating'" @click="openCreateDialog">
          {{ sessionStatus === 'creating' ? '创建中…' : '创建房间' }}
        </button>
        <button class="remote-join-btn" :disabled="!nicknameInput.trim() || sessionStatus === 'joining'" @click="dialog = 'join'">
          {{ sessionStatus === 'joining' ? '加入中…' : '加入房间' }}
        </button>
      </div>
      <p v-if="sessionError" class="session-error" role="alert">{{ sessionError }}</p>

      <RoomPanel
        v-if="roomId"
        :room-id="roomId"
        :room-time-limit="roomTimeLimit"
        :room-seats="roomSeats"
        :llm-enabled="llmEnabled"
        :effective-llm-enabled="effectiveLlmEnabled"
        :llm-available="llmAvailable"
        :llm-providers="llmProviders"
        :my-seat="mySeat"
        :is-creator="isCreator"
        :session-status="sessionStatus"
        :all-occupied-ready="allOccupiedReady"
        :match-starting="matchStarting"
        :copied="copied"
        :leaving="leaving"
        :closing="closing"
        :match-name="matchName"
        :rule-name="ruleOption.name"
        :table-theme-name="tableThemeName"
        :character-id="animeCharacterId"
        @copy="$emit('copyRoom')"
        @toggle-ready="$emit('toggleReady')"
        @start="$emit('startRemote', $event)"
        @leave="$emit('leaveRoom')"
        @close="$emit('closeRoom')"
        @update:character-id="$emit('update:animeCharacterId', $event)"
      />
    </div>

    <LobbyDialog v-if="dialog" :title="dialogTitle" :wide="dialog === 'rule' || dialog === 'character'" @close="closeDialog">
      <template v-if="dialog === 'create'">
        <GameSettingsSummary
          :match-name="matchOption.name"
          :match-description="matchOption.description"
          :rule-name="ruleOption.name"
          :rule-description="ruleOption.highlights.slice(0, 2).join(' · ')"
          @select-match="openPicker('match', true)"
          @select-rule="openPicker('rule', true)"
        />
        <label class="remote-llm-create-option" :class="{ disabled: !roomMeta?.llmAvailable }">
          <input
            v-model="remoteLlmEnabled"
            type="checkbox"
            :disabled="!roomMeta?.llmAvailable"
            data-testid="remote-llm-enabled"
          >
          <span>
            <b>空位使用服务器大模型</b>
            <small v-if="roomMeta?.llmAvailable">开局前可为每个空位选择后端提供商，不使用单机 Key</small>
            <small v-else>服务器未配置联机大模型，空位将使用普通 AI</small>
          </span>
        </label>
        <div class="dialog-actions">
          <button class="secondary" type="button" @click="dialog = null">取消</button>
          <button class="primary" type="button" :disabled="!nicknameInput.trim() || sessionStatus === 'creating'" @click="confirmCreate">确认创建</button>
        </div>
      </template>

      <template v-else-if="dialog === 'join'">
        <label class="join-dialog-field">
          <span>房间码</span>
          <input
            :value="joinCode"
            maxlength="6"
            autofocus
            placeholder="输入 6 位房间码"
            @input="$emit('update:joinCode', ($event.target as HTMLInputElement).value.toUpperCase())"
            @keyup.enter="joinCode.trim() && confirmJoin()"
          />
        </label>
        <p class="dialog-hint">场次和规则玩法由房主设置，加入后可查看。</p>
        <div class="dialog-actions">
          <button class="secondary" type="button" @click="dialog = null">取消</button>
          <button class="primary" type="button" :disabled="!joinCode.trim() || sessionStatus === 'joining'" @click="confirmJoin">确认加入</button>
        </div>
      </template>

      <AnimeCharacterPicker
        v-else-if="dialog === 'character'"
        :model-value="animeCharacterId"
        @update:model-value="selectCharacter"
      />

      <MatchTypePicker v-else-if="dialog === 'match'" :model-value="selectedMatch" @close="closePicker" @confirm="selectMatch" />
      <RuleVariantPicker v-else :model-value="selectedRule" @close="closePicker" @confirm="selectRule" @view-rules="viewRules" />
    </LobbyDialog>

    <div class="lobby-links">
      <button v-if="gameMode === 'remote'" class="text-button" @click="$emit('openStats')">我的战绩 →</button>
      <button class="text-button" @click="$emit('openRules')">游戏规则 →</button>
      <a class="repository-link" href="https://github.com/BestGuo2020/lianhuaguangdongmahjong" target="_blank" rel="noopener noreferrer" aria-label="在 GitHub 新标签页打开莲花广麻仓库">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.24c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A11 11 0 0 1 12 6.1c.98 0 1.95.13 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.26c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg>
        GitHub ↗
      </a>
    </div>
  </section>
</template>

<style scoped>
.character-shortcut {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(430px, 92vw);
  margin: 0 auto 16px;
  padding: 8px 12px;
  border: 1px solid rgba(231, 207, 147, .28);
  border-radius: 8px;
  background: rgba(0, 0, 0, .32);
  color: #e8dcb9;
  cursor: pointer;
  text-align: left;
}
.character-shortcut:hover { background: rgba(215, 174, 83, .14); border-color: #b99549; }
.character-shortcut img {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border: 2px solid #2d2923;
  border-radius: 10px 10px 4px 4px;
  object-fit: cover;
  background: #e8dcc7;
}
.character-shortcut-label { font-size: 12px; color: #a99f8a; }
.character-shortcut b { flex: 1; min-width: 0; overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
.character-shortcut-chevron { font-size: 18px; line-height: 1; color: #b99549; }
</style>
