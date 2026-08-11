<script setup lang="ts">
import { DISCLAIMER_SECTIONS, DISCLAIMER_TITLE } from '../../content/disclaimer'

defineProps<{ open: boolean }>()
const emit = defineEmits<{
  accept: []
  decline: []
}>()
</script>

<template>
  <Transition name="modal">
    <div v-if="open" class="result-backdrop disclaimer-backdrop" role="dialog" aria-modal="true" aria-labelledby="disclaimer-title">
      <section class="result-card disclaimer-card">
        <h2 id="disclaimer-title">{{ DISCLAIMER_TITLE }}</h2>
        <div class="disclaimer-scroll">
          <template v-for="(section, index) in DISCLAIMER_SECTIONS" :key="index">
            <h3 v-if="section.title">{{ section.title }}</h3>
            <p v-if="section.body">{{ section.body }}</p>
            <ol v-if="section.list?.length">
              <li v-for="(item, itemIndex) in section.list" :key="itemIndex">{{ item }}</li>
            </ol>
          </template>
        </div>
        <div class="result-actions">
          <button class="secondary" @click="emit('decline')">不同意，返回</button>
          <button @click="emit('accept')">同意并继续</button>
        </div>
      </section>
    </div>
  </Transition>
</template>
