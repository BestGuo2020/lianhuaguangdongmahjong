import { describe, expect, it } from 'vitest'

const responsiveSources = [
  ['./style.css', 'style.css'],
  ['./components/llm/AnimeCharacterPicker.vue', 'AnimeCharacterPicker.vue'],
  ['./components/table/AnimeActionCue.vue', 'AnimeActionCue.vue'],
  ['./components/table/GameTableHud.vue', 'GameTableHud.vue'],
]

async function readSource(relativePath: string) {
  // 前端 tsconfig 不引入整套 Node 类型；Vitest 运行时仍由 Node 提供只读文件访问。
  // @ts-expect-error node:fs 在测试运行时存在
  const { readFileSync } = await import('node:fs')
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8') as string
}

describe('响应式 CSS 合同', () => {
  it('禁止重新引入按具体宽高枚举设备的媒体查询', async () => {
    for (const [relativePath, name] of responsiveSources) {
      const source = await readSource(relativePath)
      expect(source, name).not.toMatch(/@media[^\{]*(?:min|max)-(?:width|height)\s*:/)
    }
  })

  it('共享骨架只使用偏方、偏长和触控能力三类横屏条件', async () => {
    const styleSource = await readSource('./style.css')
    expect(styleSource).toContain('@media (hover: none) and (pointer: coarse) and (orientation: landscape) and (max-aspect-ratio: 8 / 5)')
    expect(styleSource).toContain('@media (hover: none) and (pointer: coarse) and (orientation: landscape) and (min-aspect-ratio: 2 / 1)')
    expect(styleSource).toContain('@media (hover: none) and (pointer: coarse) and (orientation: landscape)')
    // 主指针粗指针才进入移动端几何；any-pointer 会把带触摸屏的笔记本/台式整机误判为手机。
    expect(styleSource).not.toContain('@media (any-pointer: coarse)')
    expect(styleSource).toContain('@media (orientation: portrait) and (hover: none) and (pointer: coarse)')
    // 平板（≥1024×768）用容器查询切回 PC 样式，容器查询不属于设备宽度媒体查询。
    expect(styleSource).toContain('@container (min-width: 1024px) and (min-height: 768px)')
  })
})
