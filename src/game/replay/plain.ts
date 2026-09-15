// 纯数据工具：录制记录必须能结构化克隆（IndexedDB 落库前置条件）。
//
// Vue 的 reactive/ref 深层代理无法被结构化克隆，而引擎状态全是代理；
// 引擎还可能在类型之外挂运行时字段（例如莲花把它挂在 RoundResult 上），
// 因此不在字段层面枚举/挑选，而是在录制边界把整条记录递归解包。
import { toRaw } from 'vue'

/** 递归解包 Vue 代理，得到可结构化克隆的纯数据（数组/普通对象/原始值）。 */
export function toPlain<T>(value: T): T {
  const raw = toRaw(value as never) as unknown
  if (Array.isArray(raw)) return raw.map((item) => toPlain(item)) as unknown as T
  if (raw && typeof raw === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(raw as Record<string, unknown>)) {
      copy[key] = toPlain(child)
    }
    return copy as unknown as T
  }
  return raw as T
}

/**
 * 定位第一个不可结构化克隆的字段路径（后序：优先报最深的坏节点）。
 * 落库前哨用：把 "could not be cloned" 变成可操作的字段路径，避免静默降级掩盖原因。
 */
export function firstUncloneable(value: unknown, path = '$'): string | null {
  const children: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((child, index) => [`[${index}]`, child])
    : (value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>) : [])
  for (const [key, child] of children) {
    const deeper = firstUncloneable(child, Array.isArray(value) ? `${path}${key}` : `${path}.${key}`)
    if (deeper) return deeper
  }
  try {
    structuredClone(value)
    return null
  } catch {
    return path
  }
}
