<script setup lang="ts">
import { ANIME_CHARACTERS, type CharacterId } from '../../game/llm/animeCharacters'
import { animeCharacterAvatarUrl } from '../../game/llm/animeCharacterPreference'

defineProps<{ modelValue: CharacterId }>()
defineEmits<{ 'update:modelValue': [value: CharacterId] }>()
</script>

<template>
  <section class="anime-character-picker" aria-label="二次元角色形象">
    <header><b>本家形象</b><span>仅大模型二次元主题</span></header>
    <div class="anime-character-grid" role="radiogroup" aria-label="选择本家二次元角色">
      <button
        v-for="character in ANIME_CHARACTERS"
        :key="character.id"
        type="button"
        role="radio"
        :aria-checked="modelValue === character.id"
        :class="{ active: modelValue === character.id }"
        @click="$emit('update:modelValue', character.id)"
      >
        <img :src="animeCharacterAvatarUrl(character.id)" alt="" aria-hidden="true" loading="lazy" decoding="async">
        <span>{{ character.label }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.anime-character-picker {
  display: grid;
  gap: 10px;
  margin: 14px 0;
  padding: 12px;
  border: 2px solid #2d2923;
  border-radius: 3px;
  background: #fbf1df;
  box-shadow: 4px 4px 0 rgba(45, 41, 35, .2);
  clip-path: polygon(0 5px, 7px 0, calc(100% - 8px) 0, 100% 7px, 100% calc(100% - 5px), calc(100% - 6px) 100%, 8px 100%, 0 calc(100% - 7px));
}
.anime-character-picker header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding-bottom: 7px; border-bottom: 2px solid #2d2923; }
.anime-character-picker header b { color: #2d2923; font-size: 14px; letter-spacing: .08em; }
.anime-character-picker header span { color: #776a58; font-size: 10px; }
.anime-character-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 7px; max-height: 184px; overflow-y: auto; }
.anime-character-grid button {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 4px;
  min-width: 0;
  padding: 6px 3px 5px;
  border: 2px solid #6c6256;
  border-radius: 3px;
  background: #fffaf0;
  color: #302a24;
  cursor: pointer;
  clip-path: polygon(0 3px, 4px 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 0 100%);
  transition: transform .14s ease, background-color .14s ease, border-color .14s ease;
}
.anime-character-grid button:hover { transform: translateY(-2px) rotate(-1deg); border-color: #bd5b48; }
.anime-character-grid button.active { border-color: #bd5b48; background: #f6d9c4; box-shadow: inset 0 -4px #bd5b48; transform: translateY(-1px) rotate(-1deg); }
.anime-character-grid img { width: 44px; height: 44px; border: 2px solid #2d2923; border-radius: 12px 12px 5px 5px; object-fit: cover; background: #e8dcc7; }
.anime-character-grid span { max-width: 100%; overflow: hidden; font-size: 10px; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
@media (hover: none) and (pointer: coarse) and (orientation: landscape) {
  .anime-character-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); max-height: 126px; }
  .anime-character-grid img { width: 36px; height: 36px; }
}
</style>
