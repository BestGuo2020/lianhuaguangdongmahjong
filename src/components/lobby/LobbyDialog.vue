<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import type { TableThemeName } from '../../theme/themeIdentity'
import { themePresentationByName, themePresentationCssVariables } from '../../theme/themePresentation'

interface Props {
  title: string
  wide?: boolean
  themeName?: TableThemeName
  variant?: 'create' | 'join' | 'match' | 'rule' | 'character'
}

const props = defineProps<Props>()
const emit = defineEmits<{ close: [] }>()
const activeTheme = computed(() => props.themeName ?? 'jade')
const themeStyle = computed(() => themePresentationCssVariables(themePresentationByName(activeTheme.value)))

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="modal" appear>
      <div
        class="lobby-dialog-backdrop"
        :data-table-theme="activeTheme"
        :style="themeStyle"
        data-teleport-surface="lobby-dialog"
        role="presentation"
        @mousedown.self="emit('close')"
      >
        <section class="lobby-dialog" :class="[{ wide }, variant && `${variant}-dialog`]" role="dialog" aria-modal="true" :aria-label="title">
          <header>
            <h2>{{ title }}</h2>
            <button class="lobby-dialog-close" type="button" data-action-role="light" aria-label="关闭" @click="emit('close')">×</button>
          </header>
          <slot />
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
