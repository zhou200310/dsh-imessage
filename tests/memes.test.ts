import { describe, expect, it } from 'vitest'
import { resolveMeme, splitMemeMarkers } from '../src/memes.js'

describe('meme markers in outbound text', () => {
  it('pulls every marker out and keeps the surrounding text', () => {
    const { text, captions } = splitMemeMarkers('行吧。\n[表情: 委屈，被用户指责]\n还有这句')
    expect(captions).toEqual(['委屈，被用户指责'])
    expect(text).not.toContain('[表情:')
    expect(text).toContain('行吧。')
    expect(text).toContain('还有这句')
  })

  it('collects several markers in emission order', () => {
    const { captions } = splitMemeMarkers('[表情: 一] 中间 [表情: 二]')
    expect(captions).toEqual(['一', '二'])
  })

  it('leaves text without markers untouched', () => {
    const { text, captions } = splitMemeMarkers('普通一句话')
    expect(captions).toEqual([])
    expect(text).toBe('普通一句话')
  })

  it('resolves a caption that exists in an enabled pack', () => {
    const meme = resolveMeme('不要再蹬了')
    expect(meme).toBeDefined()
    expect(meme?.file).toMatch(/memes\//u)
  })

  it('returns nothing for a caption no pack knows', () => {
    expect(resolveMeme('这张图根本不存在 zzzz')).toBeUndefined()
  })
})
