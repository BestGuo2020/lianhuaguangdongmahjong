import { describe, expect, it } from 'vitest'

/**
 * 结算页按钮文案合同（源码级）。
 *
 * 终局回到大厅后，联机玩家保留原房间与座位，由房主从房间面板开始下一场。
 * 可见文案沿用 8 月的「返回大厅」，避免把「返回房间」误认成开新场按钮。
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
  it('终局只有「返回大厅」导航，房间语义由 tooltip 说明', async () => {
    const source = await readSource('./BloodFlowSettlementHost.vue')
    const button = /<button v-if="result"[^>]*:title="([^"]*)"[^>]*@click="\$emit\('returnToLobby'\)"[^>]*>([^<]*)<\/button>/.exec(source)
    expect(button, '未找到「返回大厅」按钮').not.toBeNull()
    expect(button![1]).toContain('matchFinished')
    expect(button![2]).toBe('返回大厅')
    expect(source).not.toContain('>返回房间</button>')
  })

  it('「退出本场」只对联机可见', async () => {
    const source = await readSource('./BloodFlowSettlementHost.vue')
    const leave = /<button v-if="([^"]*)"[^>]*>退出本场<\/button>/.exec(source)
    expect(leave, '未找到「退出本场」按钮').not.toBeNull()
    expect(leave![1]).toContain('online')
  })
})
