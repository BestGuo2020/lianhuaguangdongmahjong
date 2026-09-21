// 单条超大记录的片段化（方案 §9.3）：
// 「单条超大回答按可重组片段分块，保持原文完整并受总预算约束」。
//
// 为什么需要：一条记录（例如模型返回的超长回答）可能远大于分块目标（32–64KiB），
// 不切分就会把"按字节分批"变成"一个巨块"，既撑爆队列峰值，也让读取侧不得不整块解压。
//
// 做法：把原记录**序列化成 JSON 文本**后按 UTF-16 码元切片，每片带 `id/index/total/原 tag/text`。
// 这样原文逐字保留（切片落在代理对中间也不会损坏：拼接回来仍是同一个字符串），
// 且每片的字节量有上界。读取侧按 id 重组：**缺片必须如实报出**，不能静默给半份数据。

import { utf8Bytes, type AnalysisBlockPart } from './codec'

/** 单片片段的目标字节（JSON 文本的 UTF-8 字节；留出 value 包装的余量）。 */
export const ANALYSIS_FRAGMENT_TARGET_BYTES = 32 * 1024

export interface FragmentValue {
  /** 同一组片段的标识（同一场内唯一）。 */
  id: string
  /** 片序号（0 起）。 */
  index: number
  /** 总片数。 */
  total: number
  /** 原记录的 tag（重组后还原）。 */
  tag: string
  /** 该片承载的文本（原记录 JSON 的一段）。 */
  text: string
  /** 原记录 JSON 的 UTF-8 字节总数（便于读取侧核对）。 */
  totalBytes: number
}

export interface FragmentOptions {
  /** 目标字节（默认 32KiB）。 */
  targetBytes?: number
  /** 片段 id 生成（默认自增）；注入便于单测断言。 */
  nextId?: () => string
}

let serial = 0
const defaultNextId = () => `f${++serial}`

/** 单条记录的 JSON 字节（决定要不要切）。 */
export function partBytes(part: AnalysisBlockPart): number {
  return utf8Bytes(JSON.stringify(part))
}

/**
 * 超过阈值就切成片段；否则原样返回（**保持"绝大多数记录不被包装"**，不去无谓增加体积）。
 * 片段本身用 tag `fragment`，与业务 tag 分开，读取侧先重组再分流。
 */
export function splitOversizedPart(part: AnalysisBlockPart, options: FragmentOptions = {}): AnalysisBlockPart[] {
  const target = Math.max(1_024, options.targetBytes ?? ANALYSIS_FRAGMENT_TARGET_BYTES)
  if (partBytes(part) <= target) return [part]
  const text = JSON.stringify(part.value ?? null)
  const id = (options.nextId ?? defaultNextId)()
  // 切片长度按"每片 JSON 不超过目标"反推：包装本身的字段名与 id/index 开销按固定余量扣掉。
  const overhead = 220 + utf8Bytes(id)
  const sliceUnits = Math.max(64, Math.floor(Math.max(1, target - overhead) / 4))
  const total = Math.max(1, Math.ceil(text.length / sliceUnits))
  const totalBytes = utf8Bytes(text)
  const fragments: AnalysisBlockPart[] = []
  for (let index = 0; index < total; index += 1) {
    const value: FragmentValue = {
      id, index, total, tag: part.tag,
      text: text.slice(index * sliceUnits, (index + 1) * sliceUnits),
      totalBytes,
    }
    fragments.push({ tag: 'fragment', value })
  }
  return fragments
}

export interface ReassembleResult {
  parts: AnalysisBlockPart[]
  /** 缺片的片段组 id（读取侧必须据此把这一场标成不完整，而不是给半份数据）。 */
  incomplete: string[]
  /** 重组后的记录条数（含未切分的普通记录）。 */
  fragments: number
}

/**
 * 读取侧：把片段按 `id` 重组回原记录。
 * - 片段组缺片 / 声明片数不符 ⇒ 记入 `incomplete`，该组不出现在结果里（不静默给半份）；
 * - 顺序无关（按 `index` 排序后再拼接）；
 * - 解析失败同样计入 `incomplete`（坏数据不冒充内容）。
 */
export function reassembleFragments(parts: readonly AnalysisBlockPart[]): ReassembleResult {
  const groups = new Map<string, FragmentValue[]>()
  const malformed: unknown[] = []
  // 保持**原始顺序**：片段组在它第一片出现的位置还原，普通记录原位输出
  const order: Array<{ kind: 'plain'; part: AnalysisBlockPart } | { kind: 'group'; id: string }> = []
  for (const part of parts) {
    if (part.tag !== 'fragment') { order.push({ kind: 'plain', part }); continue }
    const value = part.value as FragmentValue | null
    if (!value || typeof value.id !== 'string' || typeof value.index !== 'number'
      || typeof value.total !== 'number' || typeof value.text !== 'string' || typeof value.tag !== 'string') {
      malformed.push(value)
      continue
    }
    if (!groups.has(value.id)) order.push({ kind: 'group', id: value.id })
    groups.set(value.id, [...(groups.get(value.id) ?? []), value])
  }
  const incomplete: string[] = []
  const restored: AnalysisBlockPart[] = []
  let fragments = 0
  for (const entry of order) {
    if (entry.kind === 'plain') { restored.push(entry.part); continue }
    const group = groups.get(entry.id) ?? []
    const sorted = [...group].sort((a, b) => a.index - b.index)
    const total = sorted[0]?.total ?? 0
    if (sorted.length !== total || sorted.some((item, index) => item.index !== index)) {
      incomplete.push(entry.id)
      continue
    }
    fragments += sorted.length
    try {
      restored.push({ tag: sorted[0].tag, value: JSON.parse(sorted.map(item => item.text).join('')) as unknown })
    } catch {
      incomplete.push(entry.id)
    }
  }
  // 形状不对的片段一律计入不完整（不能当普通记录放过，也不能静默丢弃）
  if (malformed.length) incomplete.push('malformed')
  return { parts: restored, incomplete, fragments }
}
