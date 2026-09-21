import { describe, expect, it } from 'vitest'
import { analysisAreaLabel, analysisHasRecords } from './status'

// §9.2／§10.7 的展示口径：「未开启」「未记录到任何数据」「缺少决策分析记录」三者必须分开 ——
// 分别是"当时没开录制"、"开着录制但一场什么都没写"（玩法未接线等）与"曾经记过、现在库里没有"。
describe('分析区状态文案（§9.2、§10.7）', () => {
  it('三态各有明确文案', () => {
    expect(analysisAreaLabel({ analysisRecorded: true }, 'complete')).toBe('分析：完整')
    expect(analysisAreaLabel({ analysisRecorded: true }, 'partial')).toBe('分析：部分缺失')
    expect(analysisAreaLabel({ analysisRecorded: true }, 'deleted')).toBe('分析：已删除')
  })

  it('没有该场记录时：当时没开录制 ⇒「未开启」', () => {
    expect(analysisAreaLabel({ analysisRecorded: false }, 'disabled')).toBe('分析：未开启')
    expect(analysisAreaLabel({ analysisRecorded: false }, 'missing')).toBe('分析：未开启')
  })

  it('开着录制却一条都没落下 ⇒「未记录到任何数据」（不能写成"缺少/丢失"）', () => {
    expect(analysisAreaLabel({ analysisRecorded: true }, 'missing')).toBe('分析：未记录到任何数据')
    expect(analysisAreaLabel({ analysisRecorded: true }, 'disabled')).toBe('分析：未记录到任何数据')
  })

  it('旧录像（没有该字段）⇒「缺少决策分析记录」', () => {
    expect(analysisAreaLabel({}, 'disabled')).toBe('分析：缺少决策分析记录')
    expect(analysisAreaLabel({}, 'missing')).toBe('分析：缺少决策分析记录')
  })

  it('分析区不可用单独成一句，不冒充「未开启」', () => {
    expect(analysisAreaLabel({ analysisRecorded: true }, undefined)).toBe('分析：不可用')
  })

  it('只有完整与部分缺失才算有记录可读（导出/删除入口据此启用）', () => {
    expect(analysisHasRecords('complete')).toBe(true)
    expect(analysisHasRecords('partial')).toBe(true)
    expect(analysisHasRecords('deleted')).toBe(false)
    expect(analysisHasRecords('disabled')).toBe(false)
    expect(analysisHasRecords('missing')).toBe(false)
    expect(analysisHasRecords(undefined)).toBe(false)
  })
})
