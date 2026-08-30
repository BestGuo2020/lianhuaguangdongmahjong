import { describe, expect, it } from 'vitest'
import { animeAvatarForPlayer } from './animeAvatarPresentation'

describe('llmAnime 头像表现', () => {
  it.each(['jijin', 'wenjian', 'huayao', 'gaoleng'])('保留 LLM 的 %s 风格头像', (style) => {
    const avatar = `/img/llm/qwen/llm-avatar-${style}.png`
    expect(animeAvatarForPlayer({ avatar, characterId: 'qwen', playerKind: 'llm', isLlm: true })).toBe(avatar)
  })

  it('旧协议仅有 isLlm 时仍保留风格头像', () => {
    const avatar = '/img/llm/deepseek/llm-avatar-huayao.png'
    expect(animeAvatarForPlayer({ avatar, isLlm: true })).toBe(avatar)
  })

  it('真人和普通 bot 才使用所选角色的稳健基础头像', () => {
    expect(animeAvatarForPlayer({ avatar: '/human.png', characterId: 'qwen', playerKind: 'human' }))
      .toContain('/img/llm/qwen/llm-avatar-wenjian.png')
    expect(animeAvatarForPlayer({ avatar: '/bot.png', characterId: 'deepseek', playerKind: 'bot' }))
      .toContain('/img/llm/deepseek/llm-avatar-wenjian.png')
  })
})
