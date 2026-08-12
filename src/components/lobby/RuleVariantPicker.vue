<script setup lang="ts">
import { ref } from 'vue'
import { RULE_VARIANTS, type RuleVariant } from '../../game/core/rules/ruleVariants'

const props = defineProps<{ modelValue: RuleVariant }>()
const emit = defineEmits<{ close: []; confirm: [value: RuleVariant]; viewRules: [] }>()
const pending = ref(props.modelValue)
</script>

<template>
  <div class="picker-options rule-picker-options">
    <button
      v-for="option in RULE_VARIANTS"
      :key="option.id"
      type="button"
      :class="{ active: pending === option.id }"
      @click="pending = option.id"
    >
      <i aria-hidden="true"></i>
      <span>
        <b>{{ option.name }} <em v-if="option.badge">{{ option.badge }}</em></b>
        <small>{{ option.highlights.join(' · ') }}</small>
      </span>
    </button>
  </div>
  <button class="view-rules-link" type="button" @click="emit('viewRules')">查看详细规则 →</button>
  <div class="dialog-actions">
    <button class="secondary" type="button" @click="emit('close')">取消</button>
    <button class="primary" type="button" @click="emit('confirm', pending)">确定</button>
  </div>
</template>
