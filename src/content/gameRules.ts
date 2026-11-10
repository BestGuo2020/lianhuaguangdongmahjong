import { BASE_SCORE } from '../game/core/rules/rules'
import type { RuleVariant } from '../game/core/rules/ruleVariants'
import { BLOOD_FLOW_ACTION_PRIORITY, BLOOD_FLOW_CONFIG } from '../game/variants/lotus/bloodFlow/config'

interface RuleChapter {
  title: string
  paragraphs?: readonly string[]
  table?: { headings: readonly string[]; rows: ReadonlyArray<readonly (string | number)[]> }
}

const fourSeats = '四人使用 136 张牌，万、筒、索各 1～9，东、南、西、北、中、发、白各四张。庄家起手 14 张先打，闲家各 13 张。'
const matchLength = '东风场打 4 个庄位，半庄场打 8 个庄位。庄家胡牌或流局时庄家听牌则连庄，否则轮到下家坐庄。'
const dealerFollow = `第一圈三位闲家的第一张弃牌均与庄家首弃相同，庄家向三家各付 ${BASE_SCORE} 分。第一圈被吃、碰、杠或胡打断时，跟庄窗口结束。`
const drawOnlyAllWaits = '听口覆盖全部 34 种牌时只可自摸，吃胡（含地胡）和抢杠胡均不成立。杠上开花仍属于自摸。'
const controls: RuleChapter = {
  title: '出牌与听牌提示',
  paragraphs: ['电脑单击手牌出牌，手机可双击或上滑出牌。听牌提示显示听口和剩余可见张数，其他玩家的暗手不会公开。'],
}

export const windKongDescription = '东南西北各一张，须全部位于本人未副露手牌中，在本人摸牌后的回合一次声明，四张亮明并补摸。风杠本身不破门清，不可抢杠；已吃出的乱风顺不能补成风杠，也不能借他家弃牌开四风杠。'

const flip: RuleChapter = {
  title: '翻精与开门',
  paragraphs: [
    '庄家先掷两枚骰子，从庄家起按点数和数到目标方位，再在该方位按相同点数数墩。翻开该墩上层牌作为指示牌，整墩两张退出摸牌顺序。',
    '被数到的玩家再掷两枚骰子，以翻精墩为起点向后数第二次点数和加一墩，作为发牌起点。正常摸牌走牌头，杠后从牌尾补摸。',
    '指示牌和同类牌序的下一张都是精牌，可替代任意牌。白板本身为精时同样可替代任意牌，其余情况只可替代本局两种精牌的原牌面或白板自身。精牌、白板参与吃碰杠时按真实牌面使用。吃胡或抢杠时，来自他家的那张牌也按真实牌面使用。',
  ],
  table: {
    headings: ['指示牌类别', '下一张的循环顺序'],
    rows: [['万、筒、索', '同花色 1 → 2 → … → 9 → 1'], ['风牌', '东 → 南 → 西 → 北 → 东'], ['三元牌', '中 → 发 → 白 → 中']],
  },
}

function kongChapter(base: number, payments: typeof BLOOD_FLOW_CONFIG.kongPayments, withWind: boolean): RuleChapter {
  const rows = [
    ['明杠（直杠）', '手中三张同牌，取得别人弃出的第四张', `放杠者付 ${base * payments.discard} 分`],
    ['补杠', '已经碰牌，摸牌后以第四张升级为杠', `其余三家各付 ${base * payments.added} 分`],
    ['暗杠', '摸牌后以手中的四张同牌开杠', `其余三家各付 ${base * payments.concealed} 分`],
  ]
  if (withWind) rows.push(['风杠', '摸牌后用暗手中东南西北各一张开杠', `其余三家各付 ${base * payments.wind} 分`])
  return {
    title: '杠牌与即时收付',
    paragraphs: [
      '杠成立时立即记分，并从牌尾补摸。补杠可被抢胡，被抢时保留原碰，该次补杠不收分也不补牌。',
      ...(withWind ? [windKongDescription] : []),
    ],
    table: { headings: ['杠型', '条件', '收付'], rows },
  }
}

const ordinaryKongPayments = { discard: 1, added: 1, concealed: 2, wind: 2 }
const { basePoints, initialScore, patterns, eventMultipliers, openingMinimumMultiplier,
  hardWinMultiplier, maxMultiplierPerPayer, kongPayments, kongBonus } = BLOOD_FLOW_CONFIG
const kongFirst = BLOOD_FLOW_ACTION_PRIORITY === 'kong-priority'

export const gameRules: Record<RuleVariant, readonly RuleChapter[]> = {
  'lotus-classic': [
    { title: '牌具与场制', paragraphs: [fourSeats, `起始分数 1000，底分 ${BASE_SCORE}。没有翻精，白板固定为癞子。`, matchLength] },
    { title: '摸打、碰牌与跟庄', paragraphs: ['按座位依次摸打。任一家弃牌后，其他家可用两张同牌碰出刻子，或用三张同牌明杠。杠优先于碰。', dealerFollow] },
    kongChapter(BASE_SCORE, ordinaryKongPayments, false),
    { title: '红中与胡牌', paragraphs: [
      '摸到红中立即亮出，从牌尾补一张。累计摸到第四张红中立即胡牌，倍数固定为 1。红中亮牌不占胡牌所需的四组面子。',
      '普通胡牌为四组面子加一对将，面子可由顺子、刻子或杠组成。白板可补顺子、刻子或将。胡牌来源为自摸或抢补杠。',
    ] },
    { title: '买马与结算', paragraphs: [
      `胡牌后从牌头取最多 8 张马。每匹中马和每张胡家已亮出的红中各加 ${BASE_SCORE} 分。`,
      `每家支付额 = ${BASE_SCORE} × 胡牌倍数 + 中马分 + 红中分。普通自摸与抢杠胡的基础倍数为 1，无癞子和杠上开花各翻倍，可叠加。自摸向三家收同额，抢杠只向补杠者收分。`,
      '牌墙耗尽无人胡则流局，已产生的跟庄和杠分计入本局净分。场末按累计积分排名。',
    ], table: {
      headings: ['胡家相对庄家', '中马牌'],
      rows: [['庄家', '1、5、9、东'], ['下家', '2、6、红中、南'], ['对家', '3、7、发、西'], ['上家', '4、8、白、北']],
    } },
    controls,
  ],
  'lotus-legacy': [
    { title: '牌具与场制', paragraphs: [fourSeats, `起始分数 2000，基础结算单位 ${BASE_SCORE}。`, matchLength] },
    flip,
    { title: '吃碰、弃牌响应与跟庄', paragraphs: [
      '仅弃牌者的下家可吃。数牌可吃同花色连续三张，风牌可吃任意三种不同风，箭牌可吃中、发、白。其他家也可碰、杠或胡。',
      '同一张弃牌的响应按胡、杠、碰、吃依序处理，胡牌采用拦胡。精牌用作吃碰杠时按原牌面使用。',
      dealerFollow,
    ] },
    kongChapter(BASE_SCORE, ordinaryKongPayments, true),
    { title: '胡牌牌型', paragraphs: [
      '刻子、数牌顺子、乱风顺、三元顺以及已经成立的杠均可组成面子。精牌可补面子、做将或补齐特殊牌型。特殊牌型按成立的最高基础番计算。',
      drawOnlyAllWaits,
    ], table: {
      headings: ['牌型', '基础番', '条件'],
      rows: [
        ['平胡', 1, '四组面子与一对将'],
        ['七对子', 2, '14 张组成七对'],
        ['十三烂', 2, '门前清，牌面各不相同，同花色数牌至少相隔 3'],
        ['七星十三烂', 4, '十三烂中含东南西北中发白七种字牌'],
        ['十三幺', 8, '六种幺九数牌和七种字牌齐全，其中一种成对'],
        ['天胡／地胡', 10, '庄家起手胡／闲家胡庄家首弃'],
      ],
    } },
    { title: '胡牌收付与流局', paragraphs: [
      `基础胡牌额为 ${BASE_SCORE} × 基础番，另外三家分别向胡家付款。一笔收付任一方为庄家时翻倍；普通吃胡时点炮者的那一笔再翻倍。自摸、抢杠胡与杠上开花按自摸档，三家各自支付的金额按身份再乘 2。`,
      `天胡、地胡固定 10 番，另外三家各付 ${10 * BASE_SCORE} 分。规则速览的收付示例列出了各座位的付款金额。`,
      '牌墙耗尽无人胡则流局，保留已结算的杠分和跟庄分。场末按累计积分排名。',
    ] },
    controls,
  ],
  'lotus-blood-flow': [
    { title: '牌具与场制', paragraphs: [
      fourSeats, `底分 ${basePoints}，起始 ${initialScore} 分。东风场 ${BLOOD_FLOW_CONFIG.rounds.east} 局，半庄场 ${BLOOD_FLOW_CONFIG.rounds.hanchan} 局，每局轮庄。`,
      '允许负分继续对局。全场按累计积分排名。每局的胡牌、杠分可在公开流水逐笔查看。',
    ] },
    flip,
    { title: '响应与血流续胡', paragraphs: [
      '仅弃牌者的下家可吃，吃法包括数牌顺子、乱风顺和三元顺。弃牌响应可碰、直杠、胡，补杠可被抢胡。同一张牌可以多家胡。',
      kongFirst ? '争同一张弃牌时，优先级为杠、碰、吃、胡。' : '争同一张弃牌时，优先级为胡、杠、碰、吃。',
      '首胡锁定手牌。之后仍可胡牌，无胡时打出本次摸到的牌。锁手后不再吃碰，胡牌窗口没有过胡选项。',
      ...(kongFirst ? ['锁手后可开杠，条件是杠后仍然听牌。'] : []),
      `${drawOnlyAllWaits} 首胡锁手后继续适用。`,
      '本局在牌墙耗尽、最后一次响应完成后结束。胡牌牌张记入胡牌记录，对局从正常的下一个摸牌座位继续。',
    ] },
    kongChapter(basePoints, kongPayments, true),
    { title: '血流番型', paragraphs: [
      '每次胡牌用该次来牌、暗手和全部副露重新判断，取合法分解中的最高收付。被覆盖的番型不叠加。',
      '门清可与其他番型叠加。平胡要求四副顺子加一将，允许数牌顺与字牌顺。没有任何计分番型时按鸡胡结算。',
      '七对和豪华七对可以叠加断幺九、清一色、混一色、清幺九、混幺九等满足条件的牌种属性。十二落抬要求四副吃碰明杠（含补杠）全部落地，暗手单钓将，可与其他番型相加。',
      '三杠、四杠只计算已经成立的普通杠。风杠有单独的杠加成。点炮或抢杠补成的刻子不算暗刻。',
    ], table: {
      headings: ['番型', '番数', '覆盖番型'],
      rows: Object.values(patterns).map(pattern => [
        pattern.label, pattern.weight, pattern.excludes.map(id => patterns[id].label).join('、') || '—',
      ]),
    } },
    { title: '每次胡牌的支付', paragraphs: [
      `合法番型番值相加，再计每副明杠（含补杠）+${kongBonus.exposed}、暗杠 +${kongBonus.concealed}、风杠 +${kongBonus.wind}。普通点炮 ×${eventMultipliers.discard}，自摸 ×${eventMultipliers['self-draw']}，抢补杠 ×${eventMultipliers['robbed-kong']}，杠后自摸 ×${eventMultipliers['kong-bloom']}。`,
      `天胡、地胡以当次结果与 ${openingMinimumMultiplier} 倍择高。整手完全按真实牌面成立时，按硬胡 ×${hardWinMultiplier}。每位付款者最高支付 ${basePoints * maxMultiplierPerPayer} 分（${maxMultiplierPerPayer} 倍）。`,
      '点炮、抢补杠由来源玩家付给各胡家，自摸由其余三家支付，已胡玩家也参与后续收付。无庄家倍率、买马或跟庄。',
    ] },
    controls,
  ],
}
