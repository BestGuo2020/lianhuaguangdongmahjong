import type { LlmStyle, LlmTtsVoiceKey } from './config'

/**
 * `llmAnime` 首版角色白名单。该 ID 可以进入本地存储和联机协议，不能替换为
 * 用户提供的路径或 URL。
 */
export const ANIME_CHARACTER_IDS = [
  'claude',
  'deepseek',
  'doubao',
  'gemini',
  'glm',
  'gpt',
  'grok',
  'kimi',
  'minimax',
  'mistral',
  'muse',
  'qwen',
] as const

export type CharacterId = typeof ANIME_CHARACTER_IDS[number]

export const DEFAULT_ANIME_CHARACTER_ID = 'deepseek' as const satisfies CharacterId

export const ANIME_VOICE_KEYS = [
  'chi',
  'peng',
  'gang',
  'hu',
  'zimo',
  'qiangganghu',
  'win-self-draw',
  'win-discard',
  'win-robbed-kong',
  'loss',
  'draw',
] as const

export type AnimeVoiceKey = typeof ANIME_VOICE_KEYS[number]

export const ANIME_ACTION_VOICE_KEYS = [
  'chi',
  'peng',
  'gang',
  'hu',
  'zimo',
  'qiangganghu',
] as const satisfies readonly AnimeVoiceKey[]

export const ANIME_RESULT_VOICE_KEYS = [
  'win-self-draw',
  'win-discard',
  'win-robbed-kong',
  'loss',
  'draw',
] as const satisfies readonly AnimeVoiceKey[]

/** TTS 网关当前明确支持的 voice key；不允许角色合同透传任意字符串。 */
export const ANIME_TTS_VOICE_KEYS = [
  'default',
  'deepseek',
  'qwen',
  'kimi',
  'doubao',
  'minimax',
  'gpt',
  'relay_gpt',
  'glm',
  'claude',
] as const satisfies readonly Exclude<LlmTtsVoiceKey, 'auto'>[]

export type AnimeTtsVoiceKey = typeof ANIME_TTS_VOICE_KEYS[number]

/**
 * voiceKey 到部署示例 speaker 的冻结记录。合成请求仍只发送 voiceKey，实际
 * speaker 由服务端配置解析；此表用于前后端合同审计和缓存身份评审。
 */
export const ANIME_TTS_SPEAKERS: Readonly<Record<AnimeTtsVoiceKey, string>> = {
  default: 'ICL_uranus_zh_female_chunzhenshaonv_tob',
  deepseek: 'ICL_uranus_zh_female_tianmeijiaoqiao_tob',
  qwen: 'ICL_uranus_zh_female_wenrouwenya_tob',
  kimi: 'ICL_uranus_zh_female_aojiaonvyou_tob',
  doubao: 'zh_female_tianmeitaozi_uranus_bigtts',
  minimax: 'ICL_uranus_zh_female_qinglenggaoya_tob',
  gpt: 'ICL_uranus_zh_female_tiexinnvyou_tob',
  relay_gpt: 'ICL_uranus_zh_female_tiexinnvyou_tob',
  glm: 'zh_female_vv_uranus_bigtts',
  claude: 'ICL_uranus_zh_female_chengshujiejie_tob',
}

export interface AnimeCharacterProfile {
  readonly id: CharacterId
  readonly label: string
  /** 精确匹配的安全别名；不把任意 URL 或模型名当作角色 ID。 */
  readonly providerAliases: readonly string[]
  readonly voiceKey: AnimeTtsVoiceKey
  /** 当前 voiceKey 不可用时采用的已审核替代音色。 */
  readonly fallbackVoiceKey: AnimeTtsVoiceKey
  /** 当前部署示例中 voiceKey 对应的 speaker，仅用于合同审计。 */
  readonly speaker: string
  readonly lines: Readonly<Record<AnimeVoiceKey, string>>
  readonly ttsStyle: Extract<LlmStyle, '稳健'>
}

const profile = (
  id: CharacterId,
  label: string,
  providerAliases: readonly string[],
  voiceKey: AnimeTtsVoiceKey,
  fallbackVoiceKey: AnimeTtsVoiceKey,
  lines: Readonly<Record<AnimeVoiceKey, string>>,
): AnimeCharacterProfile => ({
  id,
  label,
  providerAliases,
  voiceKey,
  fallbackVoiceKey,
  speaker: ANIME_TTS_SPEAKERS[voiceKey],
  lines,
  ttsStyle: '稳健',
})

/** 角色、替代音色与 11 条固定文案的唯一前端合同。 */
export const ANIME_CHARACTERS: readonly AnimeCharacterProfile[] = [
  profile('claude', '克劳德书姬', ['claude', 'anthropic'], 'claude', 'default', {
    chi: '这一页，我吃。',
    peng: '线索碰上了。',
    gang: '这杠记下了。',
    hu: '结论是，胡了。',
    zimo: '答案自己来了。',
    qiangganghu: '这杠有解，胡。',
    'win-self-draw': '自摸成章，故事圆满收束。',
    'win-discard': '借你一牌，写下本局结尾。',
    'win-robbed-kong': '识破杠意，这一章由我收尾。',
    loss: '这页失手，翻篇再读。',
    draw: '本局留白，下一章再续。',
  }),
  profile('deepseek', '大肥鱼', ['deepseek'], 'deepseek', 'default', {
    chi: '吃一口！',
    peng: '碰上了！',
    gang: '杠起来！',
    hu: '胡啦！',
    zimo: '自摸啦！',
    qiangganghu: '这杠我抢啦！',
    'win-self-draw': '自摸到手，大肥鱼也会翻身！',
    'win-discard': '接得漂亮，这一局我赢啦！',
    'win-robbed-kong': '杠上开花？这张我先胡啦！',
    loss: '这局没吃饱，下局再来！',
    draw: '荒庄也稳住，下一局见！',
  }),
  profile('doubao', '豆包学妹', ['doubao', 'volcengine', 'volcano-ark'], 'doubao', 'default', {
    chi: '好耶，我吃！',
    peng: '碰到啦！',
    gang: '看我开杠！',
    hu: '胡啦胡啦！',
    zimo: '自摸到啦！',
    qiangganghu: '抢杠成功！',
    'win-self-draw': '自摸成功，今天手气真甜！',
    'win-discard': '谢谢这张牌，我就胡啦！',
    'win-robbed-kong': '嘿嘿，这个杠我抢到啦！',
    loss: '差一点点，下局继续加油！',
    draw: '荒庄啦，大家下一局再见！',
  }),
  profile('gemini', '双子星姬', ['gemini', 'google-ai'], 'qwen', 'default', {
    chi: '双星来吃！',
    peng: '双星相碰！',
    gang: '星轨开杠！',
    hu: '星光成胡！',
    zimo: '双星自摸！',
    qiangganghu: '星隙抢杠胡！',
    'win-self-draw': '双星汇聚，自摸落定。',
    'win-discard': '借你一张，让星局完整。',
    'win-robbed-kong': '看见杠隙，双星先胡一步。',
    loss: '星轨偏了一点，下局重来。',
    draw: '星河未决，下一局再会。',
  }),
  profile('glm', '智谱狐姬', ['glm', 'zhipu', 'bigmodel'], 'glm', 'default', {
    chi: '算清了，吃。',
    peng: '碰，验证通过。',
    gang: '杠，推演完成。',
    hu: '胡，结论成立。',
    zimo: '自摸，命中最优。',
    qiangganghu: '抢杠，判断成立。',
    'win-self-draw': '推演命中，自摸是最优解。',
    'win-discard': '收到关键牌，本局计算完成。',
    'win-robbed-kong': '杠中有隙，抢胡判断成立。',
    loss: '本轮误差已记录，下局修正。',
    draw: '样本不足，下一局继续推演。',
  }),
  profile('gpt', 'GPT龙姬', ['gpt', 'openai'], 'gpt', 'relay_gpt', {
    chi: '这张，我吃。',
    peng: '好牌，碰了。',
    gang: '机会正好，杠。',
    hu: '胡了，完成。',
    zimo: '自摸，漂亮。',
    qiangganghu: '抢杠胡，拿下。',
    'win-self-draw': '自摸完成，这轮发挥不错。',
    'win-discard': '感谢关键牌，胜局已经锁定。',
    'win-robbed-kong': '抓住杠口，这局由我拿下。',
    loss: '这次判断失误，下局调整。',
    draw: '牌局未分胜负，继续下一轮。',
  }),
  profile('grok', 'Grok小恶魔', ['grok', 'xai'], 'kimi', 'default', {
    chi: '这张归我！',
    peng: '碰！逮到你了。',
    gang: '开杠，别眨眼！',
    hu: '胡了，惊喜吧！',
    zimo: '自摸，气不气？',
    qiangganghu: '敢杠？我抢胡！',
    'win-self-draw': '自摸登场，今天我就是运气。',
    'win-discard': '送牌这么客气，那我收下啦！',
    'win-robbed-kong': '当面开杠？当然要抢胡啦！',
    loss: '哼，这局先让你得意一下。',
    draw: '没分胜负？那就再闹一局。',
  }),
  profile('kimi', 'Kimi月姬', ['kimi', 'moonshot'], 'kimi', 'default', {
    chi: '月光引牌，吃。',
    peng: '碰，月色正好。',
    gang: '月下开杠。',
    hu: '月光照胡。',
    zimo: '月来，自摸。',
    qiangganghu: '月影抢杠胡。',
    'win-self-draw': '月光送来好牌，自摸成局。',
    'win-discard': '借你一张牌，今晚月色正好。',
    'win-robbed-kong': '杠影一闪，正好让我抢胡。',
    loss: '今夜月色稍淡，下局再来。',
    draw: '月落无果，且等下一轮。',
  }),
  profile('minimax', 'MiniMax导演', ['minimax'], 'minimax', 'default', {
    chi: '素材到手，吃。',
    peng: '镜头碰上！',
    gang: '开杠，开机！',
    hu: '胡了，收工！',
    zimo: '自摸，一条过！',
    qiangganghu: '抢杠胡，卡！',
    'win-self-draw': '一条自摸，这局完美收工。',
    'win-discard': '接住这张，胜利镜头拍好了。',
    'win-robbed-kong': '抢杠成功，这段就是高光。',
    loss: '这一条不够好，下局重拍。',
    draw: '本局没有结尾，下一条继续。',
  }),
  profile('mistral', '米斯特拉风狐', ['mistral'], 'minimax', 'default', {
    chi: '顺风吃牌。',
    peng: '风起，碰。',
    gang: '乘风开杠。',
    hu: '风定，胡了。',
    zimo: '好风自摸。',
    qiangganghu: '风口抢杠胡。',
    'win-self-draw': '顺风自摸，胜局自然抵达。',
    'win-discard': '借一阵东风，这张正好成胡。',
    'win-robbed-kong': '杠风露隙，我便顺势抢胡。',
    loss: '风向有变，下一局再追。',
    draw: '风停牌尽，来局再起。',
  }),
  profile('muse', '缪斯梦姬', ['muse'], 'claude', 'default', {
    chi: '灵感来了，吃。',
    peng: '碰出灵感！',
    gang: '灵感开杠。',
    hu: '一曲成胡。',
    zimo: '自摸如歌。',
    qiangganghu: '抢杠成章。',
    'win-self-draw': '灵感自来，这一局写成了。',
    'win-discard': '借你一音，正好谱成胜曲。',
    'win-robbed-kong': '杠声未落，我已抢胡成章。',
    loss: '这一曲有遗憾，下局再写。',
    draw: '余音未定，下一局续篇。',
  }),
  profile('qwen', '千问大小姐', ['qwen', 'qwq', 'dashscope', 'tongyi'], 'qwen', 'default', {
    chi: '这张我吃。',
    peng: '碰，正合我意。',
    gang: '杠，机会来了。',
    hu: '胡了，请承让。',
    zimo: '自摸，刚刚好。',
    qiangganghu: '抢杠胡，失礼了。',
    'win-self-draw': '自摸如期而至，承让了。',
    'win-discard': '一张定局，多谢你的好牌。',
    'win-robbed-kong': '此杠有隙，我便收下胜局。',
    loss: '胜负寻常，我会再算一局。',
    draw: '牌山已尽，且待下一局。',
  }),
]

const CHARACTER_ID_SET: ReadonlySet<string> = new Set(ANIME_CHARACTER_IDS)
const CHARACTER_BY_ID: ReadonlyMap<CharacterId, AnimeCharacterProfile> = new Map(
  ANIME_CHARACTERS.map((character) => [character.id, character]),
)
const PROVIDER_ALIAS_TO_CHARACTER: ReadonlyMap<string, CharacterId> = new Map(
  ANIME_CHARACTERS.flatMap((character) => (
    character.providerAliases.map((alias) => [alias, character.id] as const)
  )),
)

const SAFE_PROVIDER_ALIAS_RE = /^[a-z0-9._-]{1,64}$/

function normalizeContractId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim().toLowerCase()
  return SAFE_PROVIDER_ALIAS_RE.test(normalized) ? normalized : null
}

/** 只判断已经是 canonical 形式的角色 ID，不执行宽松字符串推断。 */
export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === 'string' && CHARACTER_ID_SET.has(value)
}

/** 解析联机/存储中的角色白名单值；缺失、非法或未知值统一回退 DeepSeek。 */
export function resolveAnimeCharacterId(value: unknown): CharacterId {
  const normalized = normalizeContractId(value)
  return normalized && CHARACTER_ID_SET.has(normalized)
    ? normalized as CharacterId
    : DEFAULT_ANIME_CHARACTER_ID
}

/** 按安全的 provider 精确别名映射角色；不做 substring、URL 或路径猜测。 */
export function resolveAnimeCharacterIdForProvider(provider: unknown): CharacterId {
  const normalized = normalizeContractId(provider)
  return (normalized && PROVIDER_ALIAS_TO_CHARACTER.get(normalized))
    || DEFAULT_ANIME_CHARACTER_ID
}

export function resolveAnimeCharacter(value: unknown): AnimeCharacterProfile {
  return CHARACTER_BY_ID.get(resolveAnimeCharacterId(value))
    ?? CHARACTER_BY_ID.get(DEFAULT_ANIME_CHARACTER_ID)!
}

export function resolveAnimeCharacterForProvider(provider: unknown): AnimeCharacterProfile {
  return resolveAnimeCharacter(resolveAnimeCharacterIdForProvider(provider))
}

export function animeVoiceLine(character: unknown, voiceKey: AnimeVoiceKey): string {
  return resolveAnimeCharacter(character).lines[voiceKey]
}
