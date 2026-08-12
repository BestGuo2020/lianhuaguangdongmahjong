<script setup lang="ts">
import { computed } from 'vue'
import { BASE_SCORE } from '../game/core/rules/rules'
import { DISCLAIMER_SECTIONS, DISCLAIMER_TITLE } from '../content/disclaimer'
import type { RuleVariant } from '../game/core/rules/ruleVariants'

const props = defineProps<{ open: boolean; variant?: RuleVariant }>()
defineEmits(['close'])

const rules = computed(() => {
  if (props.variant === 'lotus-legacy') {
    return [
      ['多端兼容', '电脑端：鼠标单击出牌、移动端：手机双击出牌或上滑出牌'],
      ['翻精癞子', '两枚骰子翻指示牌，指示牌与同序下一张均为癞子（万/筒/索、风、箭各自循环）。'],
      ['支持吃牌', '仅下家可吃：数牌顺子、乱风吃（任意三种不同风）、箭牌吃（中发白）。'],
      ['胡牌牌型', '平胡 1番、七对子 2番、十三烂 2番、七星十三烂 4番、十三幺 8番；天胡/地胡 8番。'],
      ['面子规则', '乱风顺（任意 3 种风）、三元顺（中发白）可成面子；癞子可补缺张、做将。'],
      ['碰杠规则', '癞子不能碰/吃/杠；支持暗杠/明杠/加杠/风杠（东南西北各 1 张）。'],
      ['杠分即时', '加杠 +300 / 明杠 +100 / 暗杠 +600 / 风杠 +600，开杠立即结算。'],
      ['收付方式', '无论点炮或自摸，未胡三家都要支付；庄家为闲家 2 倍。'],
      ['翻倍加计', '自摸 ×2、抢杠胡与杠上开花各 ×2（并加计自摸）、庄 ×2；天胡/地胡平收 8 番。'],
      ['起始分数', '每位玩家起始 2000 分，基础结算单位 100。'],
    ]
  }
  return [
    ['多端兼容', '电脑端：鼠标单击出牌、移动端：手机双击出牌或上滑出牌'],
    ['只碰不吃', '可以碰牌、明杠、暗杠，不能吃牌。'],
    ['只胡两种', '仅可自摸或抢杠胡，普通弃牌不能点炮。'],
    ['白板癞子', '白板可代替任意牌完成对子、刻子或顺子。'],
    ['翻倍规则', '庄家结算 ×2，无癞子（硬胡） ×2、杠上开花 ×2。'],
    ['红中开杠', '摸到红中立即亮出，并从牌墙尾补摸一张。'],
    ['四中自摸', '累计摸到四张红中，立即按自摸胡并额外 ×4。'],
    ['胡后买马', '胡牌者摸 8 张马牌；每张 1、5、9 或红中按一份底分加算。'],
  ]
})

const panelTitle = computed(() => props.variant === 'lotus-legacy' ? '莲花麻将玩法' : '莲花广麻玩法')
const baseNote = computed(() => props.variant === 'lotus-legacy'
  ? `基础单位 ${BASE_SCORE} 分 · 番数×底分，按身份收付`
  : `基础分 ${BASE_SCORE} 分 · 总分 = 底分 × 倍数 + 中马数 × 底分`)
</script>

<template>
  <Transition name="panel">
    <aside v-if="open" class="rules-panel">
      <header>
        <div>
          <h2>{{ panelTitle }}</h2>
        </div>
        <button aria-label="关闭规则" @click="$emit('close')">×</button>
      </header>
      <div class="rule-list">
        <article v-for="(rule, index) in rules" :key="rule[0]">
          <b>{{ String(index + 1).padStart(2, '0') }}</b>
          <div><h3>{{ rule[0] }}</h3><p>{{ rule[1] }}</p></div>
        </article>
      </div>
      <div class="rule-note">{{ baseNote }}</div>
      <section class="disclaimer-block" aria-label="用户声明">
        <h3>{{ DISCLAIMER_TITLE }}</h3>
        <template v-for="(section, index) in DISCLAIMER_SECTIONS" :key="index">
          <h4 v-if="section.title">{{ section.title }}</h4>
          <p v-if="section.body">{{ section.body }}</p>
          <ol v-if="section.list?.length">
            <li v-for="(item, itemIndex) in section.list" :key="itemIndex">{{ item }}</li>
          </ol>
        </template>
      </section>
    </aside>
  </Transition>
</template>
