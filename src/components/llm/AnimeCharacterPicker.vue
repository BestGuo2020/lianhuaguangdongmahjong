<script setup lang="ts">
import { computed, ref } from 'vue'
import { ANIME_CHARACTERS, type CharacterId } from '../../game/llm/animeCharacters'
import { animeCharacterAvatarUrl } from '../../game/llm/animeCharacterPreference'

const props = defineProps<{ modelValue: CharacterId }>()
defineEmits<{ 'update:modelValue': [value: CharacterId] }>()

const failedAvatars = ref(new Set<CharacterId>())
const currentCharacter = computed(() => (
  ANIME_CHARACTERS.find((character) => character.id === props.modelValue) ?? ANIME_CHARACTERS[0]
))

function markAvatarFailed(characterId: CharacterId) {
  failedAvatars.value = new Set(failedAvatars.value).add(characterId)
}
</script>

<template>
  <section class="anime-character-picker" aria-label="二次元角色形象">
    <header><b>选择本家形象</b><span>点击切换</span></header>
    <div class="anime-character-picker-layout">
      <article class="anime-character-preview" data-testid="anime-character-preview" aria-live="polite">
        <div class="anime-character-preview-art">
          <img
            v-if="!failedAvatars.has(currentCharacter.id)"
            :src="animeCharacterAvatarUrl(currentCharacter.id)"
            :alt="`${currentCharacter.label}形象预览`"
            decoding="async"
            @error="markAvatarFailed(currentCharacter.id)"
          >
          <span v-else class="anime-avatar-fallback" aria-hidden="true">{{ currentCharacter.label.slice(0, 1) }}</span>
        </div>
        <div>
          <small>当前选中</small>
          <h3>{{ currentCharacter.label }}</h3>
          <p>{{ currentCharacter.description }}</p>
        </div>
      </article>

      <div class="anime-character-grid" role="radiogroup" aria-label="选择本家二次元角色">
        <button
          v-for="character in ANIME_CHARACTERS"
          :key="character.id"
          type="button"
          role="radio"
          :aria-label="`${character.label}：${character.description}`"
          :aria-checked="modelValue === character.id"
          :class="{ active: modelValue === character.id }"
          @click="$emit('update:modelValue', character.id)"
        >
          <span class="anime-character-thumb">
            <img
              v-if="!failedAvatars.has(character.id)"
              :src="animeCharacterAvatarUrl(character.id)"
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              @error="markAvatarFailed(character.id)"
            >
            <span v-else class="anime-avatar-fallback" aria-hidden="true">{{ character.label.slice(0, 1) }}</span>
          </span>
          <span>{{ character.label }}</span>
          <i v-if="modelValue === character.id" aria-hidden="true">✓</i>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.anime-character-picker {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}
.anime-character-picker header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding-bottom: 7px; border-bottom: 2px solid #2d2923; }
.anime-character-picker header b { color: #2d2923; font-size: 14px; letter-spacing: .08em; }
.anime-character-picker header span { color: #776a58; font-size: 10px; }
.anime-character-picker-layout { display: grid; grid-template-columns: minmax(180px, .85fr) minmax(210px, 1.15fr); gap: 12px; min-height: 0; overflow: hidden; }
.anime-character-preview { display: grid; align-content: start; gap: 8px; min-width: 0; margin: 0; padding: 9px; overflow: hidden; border: 2px solid #2d2923; border-radius: 4px; background: #fffaf0; color: #302a24; box-shadow: 4px 4px 0 rgba(189,91,72,.32); }
.anime-character-preview-art { display: grid; width: 100%; aspect-ratio: 1; place-items: center; overflow: hidden; border: 2px solid #2d2923; border-radius: 18px 18px 6px 6px; background: #e8dcc7; }
.anime-character-preview-art img { display: block; width: 100%; height: 100%; object-fit: contain; }
.anime-character-preview small { color: #9b4034; font-size: 9px; font-weight: 900; letter-spacing: .16em; }
.anime-character-preview h3 { margin: 2px 0 4px; color: #2d2923; font-size: 19px; line-height: 1.2; word-break: keep-all; }
.anime-character-preview p { display: -webkit-box; margin: 0; overflow: hidden; color: #6b5c4e; font-size: 11px; line-height: 1.55; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
.anime-character-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); align-content: start; gap: 7px; min-height: 0; max-height: 310px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 1px 3px 5px 1px; }
.anime-character-grid button {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 4px;
  min-width: 0;
  padding: 6px 3px 5px;
  border: 1px solid rgba(108, 98, 86, .48);
  border-radius: 3px;
  background: #fffaf0;
  color: #302a24;
  cursor: pointer;
  /* 保留完整边界，避免裁掉键盘焦点环。 */
  transition: transform .14s ease, background-color .14s ease, border-color .14s ease;
}
.anime-character-grid button:hover { transform: translateY(-2px) rotate(-1deg); border-color: #bd5b48; }
.anime-character-grid { scrollbar-width: thin; scrollbar-color: #bd5b48 #f3e5cf; }
.anime-character-grid button:focus-visible { outline: 2px solid #9f4035; outline-offset: -3px; }
.anime-character-grid button:active { transform: translateY(1px); }
.anime-character-grid button.active { border-width: 2px; border-color: #bd5b48; background: #f6d9c4; box-shadow: inset 0 -4px #bd5b48; transform: translateY(-1px) rotate(-1deg); }
.anime-character-thumb { display: grid; width: 52px; height: 52px; place-items: center; overflow: hidden; border: 1px solid rgba(45,41,35,.54); border-radius: 12px 12px 5px 5px; background: #e8dcc7; }
.anime-character-grid img { width: 100%; height: 100%; object-fit: cover; }
.anime-character-grid button > span:not(.anime-character-thumb) { display: -webkit-box; max-width: 100%; min-height: 2.6em; overflow: hidden; font-size: 10px; font-weight: 800; line-height: 1.3; white-space: normal; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.anime-character-grid i { position: absolute; top: 4px; right: 4px; display: grid; width: 17px; height: 17px; place-items: center; border: 2px solid #2d2923; border-radius: 50%; background: #bd5b48; color: #fffaf0; font-size: 10px; font-style: normal; font-weight: 900; }
.anime-avatar-fallback { display: grid; width: 100%; height: 100%; place-items: center; color: #8d4b3f; font: 900 28px "Yu Gothic", "Microsoft YaHei", sans-serif; }
@media (hover: none) and (pointer: coarse) and (orientation: landscape) {
  .anime-character-preview { grid-template-columns: 62px minmax(0, 1fr); align-items: center; gap: 6px; padding: 7px; }
  .anime-character-preview-art { width: 62px; }
  .anime-character-preview h3 { font-size: 16px; }
  .anime-character-preview p { font-size: 9px; line-height: 1.35; -webkit-line-clamp: 4; }
  .anime-character-grid { grid-template-columns: repeat(auto-fit, minmax(58px, 1fr)); max-height: 154px; }
  .anime-character-thumb { width: 36px; height: 36px; }
}
</style>
