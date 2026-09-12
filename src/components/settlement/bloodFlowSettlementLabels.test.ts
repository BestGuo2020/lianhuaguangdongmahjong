import { describe, expect, it } from 'vitest'

/**
 * 结算页按钮文案合同（源码级）。
 *
 * 背景：`online=false`（单机）时结算页不能出现只对房间有意义的文案——单机没有房间可回。
 * 曾经出过的问题：`返回大厅` 按钮的 `title` 判了 `!online`，但**可见文案**只按 `matchFinished`
 * 取值，于是单机整场结束时按钮写成「返回房间」（用户报错）。这里把两者的一致性钉住。
 *
 * 为什么是源码断言：前端只跑 Playwright e2e（无 DOM/组件单测工具），这条纯文案约束放在
 * vitest 里才能在每次 `pnpm test` 廉价地拦住回归；交互行为仍由
 * `tests/e2e/blood-flow.settlement-navigation.spec.ts` 覆盖。
 */
async function readSource(relativePath: string) {
  // @ts-expect-error node:fs 在测试运行时存在
  const { readFileSync } = await import('node:fs')
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8') as string
}

describe('血流结算页按钮合同', () => {
  it('返回大厅/返回房间 的可见文案与 tooltip 都按 online 区分', async () => {
    const source = await readSource('./BloodFlowSettlementHost.vue')
    const label = /:title="([^"]*)"[^>]*>\{\{([^}]*)\}\}<\/button>/.exec(source)
    expect(label, '未找到「返回大厅」按钮的 title + 文案表达式').not.toBeNull()
    const [, titleExpression, textExpression] = label!
    expect(titleExpression).toContain('!online')
    // 文案必须先判 online，再按 matchFinished 取「返回房间」——单机永远只能是「返回大厅」。
    expect(textExpression).toContain('!online')
    expect(textExpression).toMatch(/!\s*online\s*\?[^:]*返回大厅/)
    expect(textExpression).toContain('返回房间')
  })

  it('「退出本场」只对联机可见', async () => {
    const source = await readSource('./BloodFlowSettlementHost.vue')
    const leave = /<button v-if="([^"]*)"[^>]*>退出本场<\/button>/.exec(source)
    expect(leave, '未找到「退出本场」按钮').not.toBeNull()
    expect(leave![1]).toContain('online')
  })
})
