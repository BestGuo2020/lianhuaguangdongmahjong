import { describe, expect, it } from 'vitest'

const sourceUrl = new URL('./LlmSettingsPanel.vue', import.meta.url)

async function readPanelSource() {
  // 前端 tsconfig 不引入 Node 类型；Vitest 运行时仍提供只读文件访问。
  // @ts-expect-error node:fs 在测试运行时存在
  const { readFileSync } = await import('node:fs')
  return readFileSync(sourceUrl, 'utf8') as string
}

describe('AI 大模型配置页内容保护合同', () => {
  it('保留关键字段、操作和原有 DOM 顺序', async () => {
    const source = await readPanelSource()
    const expectedOrder = [
      'llm-close',
      'llm-enabled',
      'llm-provider-list',
      'llm-provider-item',
      'llm-template',
      'llm-add',
      'llm-seat-default',
      'llm-seat',
      'llm-seat-style',
      'llm-name',
      'llm-nickname',
      'llm-avatar-folder',
      'llm-provider-type',
      'llm-base-url',
      'llm-api-key',
      'llm-model',
      'llm-timeout-enabled',
      'llm-style',
      'llm-tts-voice',
      'llm-remove',
      'llm-save',
      'llm-test',
      'llm-clear-key',
      'llm-export-json',
      'llm-import-json',
      'llm-import-file',
    ]
    const positions = expectedOrder.map((testId) => source.indexOf(`data-testid="${testId}"`))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('保留密码遮蔽、自动填充约束、四种风格与 Teleport 主题入口', async () => {
    const source = await readPanelSource()
    expect(source).toMatch(/type="password" autocomplete="off"[^>]*data-testid="llm-api-key"/)
    for (const style of ['激进', '稳健', '话痨', '高冷']) {
      expect(source).toContain(`<option value="${style}">${style}</option>`)
    }
    expect(source).toContain('<Teleport to="body">')
    expect(source).toContain('data-teleport-surface="llm-settings"')
    expect(source).toContain(':data-table-theme="activeTheme"')
  })
})
