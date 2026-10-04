<script setup lang="ts">
import { computed } from 'vue'
import { BASE_SCORE } from '../game/core/rules/rules'
import { DISCLAIMER_SECTIONS, DISCLAIMER_TITLE } from '../content/disclaimer'
import type { RuleVariant } from '../game/core/rules/ruleVariants'
import { BLOOD_FLOW_CONFIG } from '../game/variants/lotus/bloodFlow/config'

const props = defineProps<{ open: boolean; variant?: RuleVariant }>()
defineEmits(['close'])

const legacyPaymentExamples = [
  { title: '庄家吃胡闲家', winner: '庄家',
    payments: [{ payer: '点炮闲家', amount: 400 }, { payer: '其余两位闲家', amount: 200, each: true }], total: 800 },
  { title: '庄家自摸', winner: '庄家',
    payments: [{ payer: '三位闲家', amount: 400, each: true }], total: 1200 },
  { title: '庄家抢杠胡', winner: '庄家',
    payments: [{ payer: '三位闲家（含被抢杠者）', amount: 400, each: true }], total: 1200,
    note: '按自摸型收付，被抢杠者不再单独双付。' },
  { title: '闲家吃胡闲家', winner: '胡牌闲家',
    payments: [{ payer: '庄家', amount: 200 }, { payer: '点炮闲家', amount: 200 }, { payer: '另一位闲家', amount: 100 }], total: 500 },
  { title: '闲家吃胡庄家', winner: '胡牌闲家',
    payments: [{ payer: '点炮庄家', amount: 400 }, { payer: '其余两位闲家', amount: 100, each: true }], total: 600 },
  { title: '闲家自摸', winner: '胡牌闲家',
    payments: [{ payer: '庄家', amount: 400 }, { payer: '其余两位闲家', amount: 200, each: true }], total: 800 },
  { title: '闲家抢杠胡', winner: '胡牌闲家',
    payments: [{ payer: '庄家', amount: 400 }, { payer: '其余两位闲家', amount: 200, each: true }], total: 800,
    note: '抢庄家或闲家的补杠，均按此表支付；被抢杠者不再单独双付。' },
  { title: '特殊天地胡（不计庄家）', winner: '胡家',
    payments: [{ payer: '另外三家（不分庄闲）', amount: 1000, each: true }], total: 3000,
    note: '天胡：三位闲家付给庄家；地胡：庄家和另外两位闲家付给胡牌闲家。固定10番，不叠加平胡、自摸、庄家或点炮者翻倍。' },
]

const windKongDescription = '东南西北各一张，须全部位于本人未副露手牌中，在本人摸牌后的回合一次声明，四张亮明并补摸。风杠本身不破门清，不可抢杠；已吃出的乱风顺不能补成风杠，也不能借他家弃牌开四风杠。'

const rules = computed(() => {
  if (props.variant === 'lotus-blood-flow') return [
    ['血流到底', '首胡后锁定暗手和副露，可继续胡牌；摸牌不胡时只能摸切。牌墙耗尽且最后响应完成才结束本局。'],
    ['翻精与硬胡', '两次掷骰、双精、白板受限替代。每次胡按完整副露和胡牌张重新判型；完全按真实牌面成立为硬胡 ×2。'],
    ['听任意仅自摸', '精吊任意听（听口覆盖全部牌张）只能自摸胡；吃胡、地胡与抢杠胡均不成立，杠上开花保留。首胡锁手后仍按此限制。'],
    ['收付规则', '底分 10，起始 2000。点炮与抢补杠由来源玩家付，自摸由其他三家付，已胡也付；允许负分和多响。'],
    ['组合与封顶', '同一合法分解按 1 + 各番型(倍数−1) 相加；包含项不重复加分。普通点炮 ×1、自摸 ×2、抢补杠 ×2、杠后自摸 ×4，再计硬胡，单家最终 64 倍封顶。'],
    ['番型目录', Object.values(BLOOD_FLOW_CONFIG.patterns).map(p => `${p.label} ${p.weight}倍`).join('、')],
    ['杠与场制', '直杠来源付 10；补杠其他三家各付 10；暗杠/风杠各付 20。东风 4 局、半庄 8 局，局末轮庄，无庄家倍率或买马。'],
    ['风杠', windKongDescription],
  ]
  if (props.variant === 'lotus-legacy') {
    return [
      ['多端兼容', '电脑端：鼠标单击出牌、移动端：手机双击出牌或上滑出牌'],
      ['翻精癞子', '两枚骰子翻指示牌，指示牌与同序下一张均为癞子（万/筒/索、风、箭各自循环）。'],
      ['支持吃牌', '仅下家可吃：数牌顺子、乱风吃（任意三种不同风）、箭牌吃（中发白）。'],
      ['胡牌牌型', '平胡 1番、七对子 2番、十三烂 2番、七星十三烂 4番、十三幺 8番；天胡/地胡 10番。'],
      ['听任意仅自摸', '听口覆盖全部牌张（听任意，常见为单吊精牌）时只能自摸胡；点炮胡、地胡与抢杠胡均不成立。'],
      ['面子规则', '乱风顺（任意 3 种风）、三元顺（中发白）可成面子；精牌可补缺张、做将；白板翻精时即精，可替代任意牌，否则只能替代本局精牌或白板本身；二者也可按自身牌面作为普通牌参与吃碰杠。'],
      ['碰杠规则', '精牌可以打出，并可按自身牌面参与吃、碰、明杠、暗杠、加杠和风杠（东南西北各 1 张）。'],
      ['风杠', windKongDescription],
      ['杠分即时', '加杠 +300 / 明杠 +100 / 暗杠 +600 / 风杠 +600，开杠立即结算。'],
      ['收付方式', '每次胡牌，另外三家都分别向胡家付款；普通吃胡时，点炮者把自己那一笔再付双倍。自摸、抢杠不对某一付款者单独双付，庄闲收付金额见下方例子。'],
      ['翻倍加计', '普通吃胡按庄闲档收付，点炮者的那一笔再翻倍；自摸、抢杠胡、杠上开花按自摸档收付。天胡/地胡固定10番，三家各付1000分，不叠加庄家、自摸或点炮者翻倍。'],
      ['起始分数', '每位玩家起始 2000 分，基础结算单位 100。'],
    ]
  }
  return [
    ['多端兼容', '电脑端：鼠标单击出牌、移动端：手机双击出牌或上滑出牌'],
    ['只碰不吃', '可以碰牌、明杠、暗杠，不能吃牌。'],
    ['只胡两种', '仅可自摸或抢杠胡，普通弃牌不能点炮。'],
    ['白板癞子', '白板可代替任意牌完成对子、刻子或顺子。'],
    ['翻倍规则', '无癞子（硬胡） ×2、杠上开花 ×2；不设庄家倍率，自摸时三家同额支付。'],
    ['红中开杠', '摸到红中立即亮出，并从牌墙尾补摸一张；胡牌时自己已亮的红中每张加算一份底分。'],
    ['四红中即胡', '累计摸到第四张红中立即胡牌：倍数固定 ×1（不计自摸/无癞子），按 1 份底分 + 红中 4 张加算。'],
    ['胡后买马', '胡牌者从牌头摸 8 张马牌，按胡牌者相对庄家的座位判定中马：庄家 1/5/9 与东、下家 2/6 与红中南、对家 3/7 与发西、上家 4/8 与白北；每中一张按一份底分加算。'],
  ]
})

const panelTitle = computed(() => props.variant === 'lotus-blood-flow' ? '莲花麻将·血流玩法' : props.variant === 'lotus-legacy' ? '莲花麻将玩法' : '莲花广麻玩法')
const baseNote = computed(() => props.variant === 'lotus-blood-flow' ? '底分 10 · 单家每次最多 640 分 · 牌墙耗尽结束本局' : props.variant === 'lotus-legacy'
  ? `基础单位 ${BASE_SCORE} 分 · 番数×底分，按身份收付`
  : `基础分 ${BASE_SCORE} 分 · 总分 = 底分 × 倍数 + 中马数 × 底分 + 红中数 × 底分`)
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
          <div>
            <h3>{{ rule[0] }}</h3><p>{{ rule[1] }}</p>
            <section v-if="variant === 'lotus-legacy' && rule[0] === '收付方式'" class="legacy-payment-examples" aria-label="翻精平胡分数流向">
              <p class="legacy-payment-intro">以下以平胡1番、底分100分为例，只列胡牌收付，杠分另算。其他普通牌型按基础番数同比增加；天地胡按第8例平收。</p>
              <ol>
                <li v-for="example in legacyPaymentExamples" :key="example.title">
                  <h4>{{ example.title }}</h4>
                  <p v-for="payment in example.payments" :key="payment.payer" class="legacy-payment-flow">
                    {{ payment.payer }} → {{ example.winner }}：<strong>{{ payment.each ? '各' : '' }}{{ payment.amount }}分</strong>
                  </p>
                  <p class="legacy-payment-total">{{ example.winner }}合计收入：+{{ example.total }}分</p>
                  <p v-if="example.note" class="legacy-payment-note">{{ example.note }}</p>
                </li>
              </ol>
            </section>
          </div>
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

<style scoped>
.legacy-payment-examples { margin-top: 12px; }
.legacy-payment-examples .legacy-payment-intro { font-size: 12px; }
.legacy-payment-examples ol { margin: 12px 0 0; padding-left: 20px; }
.legacy-payment-examples li { padding: 10px 0; border-top: 1px solid var(--theme-border, rgba(255,255,255,.12)); }
.legacy-payment-examples li::marker { color: var(--theme-accent-text, #b18c48); font-weight: 700; }
.legacy-payment-examples h4 { margin: 0 0 6px; color: var(--theme-text, #f0dfba); font-size: 13px; }
.legacy-payment-examples .legacy-payment-flow { overflow-wrap: anywhere; font-size: 12px; }
.legacy-payment-flow strong { color: var(--theme-text, #f0dfba); white-space: nowrap; }
.legacy-payment-examples .legacy-payment-total { margin-top: 5px; color: var(--theme-accent-text, #c2aa73); font-weight: 700; font-size: 12px; }
.legacy-payment-examples .legacy-payment-note { margin-top: 4px; font-size: 11px; }
</style>
