<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

interface Props {
  title: string
  wide?: boolean
}

defineProps<Props>()
const emit = defineEmits<{ close: [] }>()

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="modal" appear>
      <div class="lobby-dialog-backdrop" role="presentation" @mousedown.self="emit('close')">
        <section class="lobby-dialog" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
          <header>
            <h2>{{ title }}</h2>
            <button class="lobby-dialog-close" type="button" aria-label="关闭" @click="emit('close')">×</button>
          </header>
          <slot />
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
