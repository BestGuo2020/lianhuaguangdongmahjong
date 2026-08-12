<script setup lang="ts">
import { ref } from 'vue'
import type { MatchType } from '../../game/core/contracts/types'

const props = defineProps<{ modelValue: MatchType }>()
const emit = defineEmits<{ close: []; confirm: [value: MatchType] }>()
const pending = ref(props.modelValue)

const options: Array<{ id: MatchType; name: string; description: string }> = [
  { id: 'east', name: '东风场', description: '一场 4 局（不含连庄）' },
  { id: 'hanchan', name: '半庄场', description: '一场 8 局（不含连庄）' },
]
</script>

<template>
  <div class="picker-options">
    <button
      v-for="option in options"
      :key="option.id"
      type="button"
      :class="{ active: pending === option.id }"
      @click="pending = option.id"
    >
      <i aria-hidden="true"></i>
      <span><b>{{ option.name }}</b><small>{{ option.description }}</small></span>
    </button>
  </div>
  <div class="dialog-actions">
    <button class="secondary" type="button" @click="emit('close')">取消</button>
    <button class="primary" type="button" @click="emit('confirm', pending)">确定</button>
  </div>
</template>
