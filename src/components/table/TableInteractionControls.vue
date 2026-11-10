<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { QUICK_CHAT_PAGES, TABLE_EMOTES, type TableInteraction } from '../../game/shared/tableInteractions'
import TableControlIcon from './TableControlIcon.vue'
import TableEmoteArt from './TableEmoteArt.vue'

const props = defineProps<{
  target: { seat: number; name: string } | null
  send: (action: TableInteraction) => boolean
}>()
defineEmits<{ closeTarget: [] }>()

const chat = ref<HTMLDialogElement | null>(null)
const emotes = ref<HTMLDialogElement | null>(null)
const chatOpen = ref(false)
const chatPage = ref(0)
const notice = ref('')
const chatTitle = useId()
const emoteTitle = useId()

function openChat() {
  if (!chat.value || chat.value.open) return
  notice.value = ''
  chat.value.showModal()
  chatOpen.value = true
}

function send(action: TableInteraction, dialog: HTMLDialogElement | null) {
  if (props.send(action)) dialog?.close()
  else notice.value = '暂时无法发送，请稍等一下'
}

watch(chatPage, () => { notice.value = '' })
watch([emotes, () => props.target], ([dialog, target]) => {
  if (!dialog) return
  if (target && !dialog.open) {
    notice.value = ''
    dialog.showModal()
  } else if (!target && dialog.open) dialog.close()
}, { flush: 'post' })
</script>

<template>
  <button type="button" class="action quick-chat-trigger" data-action-role="secondary"
    aria-label="快捷语" title="快捷语" aria-haspopup="dialog" :aria-expanded="chatOpen" @click="openChat">
    <TableControlIcon name="chat" />
  </button>
  <dialog ref="chat" class="table-interaction-dialog" :aria-labelledby="chatTitle"
    @close="chatOpen = false" @click.self="chat?.close()">
    <header>
      <h2 :id="chatTitle">快捷语</h2>
      <button type="button" class="interaction-close" aria-label="关闭快捷语" autofocus @click="chat?.close()">
        <TableControlIcon name="close" />
      </button>
    </header>
    <div class="quick-chat-tabs" role="group" aria-label="快捷语分类">
      <button v-for="(page, index) in QUICK_CHAT_PAGES" :key="page.id" type="button"
        :aria-pressed="chatPage === index" @click="chatPage = index">{{ page.label }}</button>
    </div>
    <div class="quick-chat-grid" :aria-label="QUICK_CHAT_PAGES[chatPage]?.label">
      <button v-for="phrase in QUICK_CHAT_PAGES[chatPage]?.phrases" :key="phrase.id" type="button"
        :data-phrase-id="phrase.id" @click="send({ type: 'quick_chat', phraseId: phrase.id }, chat)">
        {{ phrase.text }}
      </button>
    </div>
    <p v-if="notice" class="interaction-notice" role="status">{{ notice }}</p>
  </dialog>

  <dialog ref="emotes" class="table-interaction-dialog table-emote-dialog" :aria-labelledby="emoteTitle"
    @close="$emit('closeTarget')" @click.self="emotes?.close()">
    <header>
      <h2 :id="emoteTitle">对 {{ target?.name }} 使用互动道具</h2>
      <button type="button" class="interaction-close" aria-label="关闭互动道具" autofocus @click="emotes?.close()">
        <TableControlIcon name="close" />
      </button>
    </header>
    <div v-if="target" class="emote-grid">
      <button v-for="emote in TABLE_EMOTES" :key="emote.id" type="button" :data-emote-choice="emote.id"
        @click="send({ type: 'emote', emote: emote.id, targetSeat: target.seat }, emotes)">
        <TableEmoteArt :kind="emote.id" :size="44" />
        <span>{{ emote.label }}</span>
      </button>
    </div>
    <p v-if="notice" class="interaction-notice" role="status">{{ notice }}</p>
  </dialog>
</template>

<style scoped>
.table-interaction-dialog {
  position: fixed;
  inset: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
  width: min(440px, calc(100vw - var(--safe-left) - var(--safe-right) - 16px));
  max-width: none;
  max-height: calc(100dvh - var(--safe-top) - var(--safe-bottom) - 16px);
  margin: auto;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--theme-border);
  border-radius: 12px;
  background: var(--theme-panel);
  color: var(--theme-text);
  box-shadow: 0 18px 60px #0009;
}
.table-interaction-dialog[open] { display: flex; flex-direction: column; }
.table-interaction-dialog::backdrop { background: #0009; }
.table-interaction-dialog header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 12px 4px 14px;
  border-bottom: 1px solid var(--theme-border);
  background: var(--theme-panel-elevated);
}
.table-interaction-dialog h2 { min-width: 0; margin: 0; color: var(--theme-accent-text); font-size: 16px; overflow-wrap: anywhere; }
.table-interaction-dialog button {
  min-height: var(--control-hit-target);
  padding: 6px 9px;
  border: 1px solid var(--theme-border);
  border-radius: 8px;
  background: var(--theme-panel);
  color: var(--theme-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.table-interaction-dialog button:hover,
.table-interaction-dialog button[aria-pressed="true"] { border-color: var(--theme-accent); background: var(--theme-panel-elevated); }
.table-interaction-dialog button[aria-pressed="true"] { color: var(--theme-accent-text); font-weight: 700; }
.table-interaction-dialog button:focus-visible { outline: 2px solid var(--theme-accent); outline-offset: -2px; }
.interaction-close { display: grid; place-items: center; flex: none; width: var(--control-hit-target); }
.quick-chat-tabs { display: flex; gap: 6px; flex: none; padding: 8px 12px 0; }
.quick-chat-tabs button { flex: 1; }
.quick-chat-grid, .emote-grid {
  display: grid;
  gap: 6px;
  min-height: 0;
  padding: 8px 12px 12px;
  overflow: auto;
  overscroll-behavior: contain;
}
.quick-chat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.quick-chat-grid button { text-align: left; line-height: 1.35; overflow-wrap: anywhere; }
.table-emote-dialog { width: min(390px, calc(100vw - var(--safe-left) - var(--safe-right) - 16px)); }
.emote-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.emote-grid button { display: grid; justify-items: center; gap: 3px; }
.interaction-notice { flex: none; margin: 0 12px 9px; color: var(--theme-text-muted); font-size: 12px; }
</style>
