<script setup lang="ts">
import { BASE_SCORE } from '../game/rules'

defineProps({ open: Boolean })
defineEmits(['close'])

const rules = [
  ['只碰不吃', '可以碰牌、明杠、暗杠，不能吃牌。'],
  ['只胡两种', '仅可自摸或抢杠胡，普通弃牌不能点炮。'],
  ['白板癞子', '白板可代替任意牌完成对子、刻子或顺子。'],
  ['双倍规则', '庄家结算 ×2，胡牌时手牌无白板再 ×2。'],
  ['红中开杠', '摸到红中立即亮出，并从牌墙尾补摸一张。'],
  ['四中自摸', '累计摸到四张红中，立即按自摸胡并额外 ×4。'],
  ['胡后买马', '胡牌者摸 8 张马牌；每张 1、5、9 或红中按一份底分加算。'],
]
</script>

<template>
  <Transition name="panel">
    <aside v-if="open" class="rules-panel">
      <header>
        <div>
          <h2>莲花广麻玩法</h2>
        </div>
        <button aria-label="关闭规则" @click="$emit('close')">×</button>
      </header>
      <div class="rule-list">
        <article v-for="(rule, index) in rules" :key="rule[0]">
          <b>{{ String(index + 1).padStart(2, '0') }}</b>
          <div><h3>{{ rule[0] }}</h3><p>{{ rule[1] }}</p></div>
        </article>
      </div>
      <div class="rule-note">基础分 {{ BASE_SCORE }} 分 · 总分 = 底分 × 倍数 + 中马数 × 底分</div>
    </aside>
  </Transition>
</template>
