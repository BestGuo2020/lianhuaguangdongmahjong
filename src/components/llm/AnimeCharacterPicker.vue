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
.anime-character-picker { display: grid; gap: 8px; margin: 12px 0; padding: 10px; border: 1px solid #b99b69; border-radius: 10px; background: #e9deca; box-shadow: inset 0 1px rgba(255,255,255,.72); }
.anime-character-picker header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.anime-character-picker header b { color: #3f332a; font-size: 14px; }
.anime-character-picker header span { color: #796b5b; font-size: 10px; }
.anime-character-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; max-height: 174px; overflow-y: auto; }
.anime-character-grid button { display: grid; justify-items: center; gap: 3px; min-width: 0; padding: 5px 3px; border: 1px solid #cbb896; border-radius: 8px; background: #f7f0e4; color: #44382f; cursor: pointer; }
.anime-character-grid button.active { border-color: #a95345; background: #ead3b8; box-shadow: inset 0 -3px #a95345; }
.anime-character-grid img { width: 40px; height: 40px; border: 2px solid #c2a36d; border-radius: 50%; object-fit: cover; background: #f3eadb; }
.anime-character-grid span { max-width: 100%; overflow: hidden; font-size: 10px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 700px), (max-height: 520px) {
  .anime-character-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); max-height: 126px; }
  .anime-character-grid img { width: 32px; height: 32px; }
}
</style>
