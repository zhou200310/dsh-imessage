import { describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { canSynthesize, canTranscribe, splitVoiceMarkers, synthesize, transcribe } from '../src/voice.js'

describe('voice markers in outbound text', () => {
  it('pulls a spoken segment out and keeps the rest', () => {
    const { text, segments } = splitVoiceMarkers('说完了。\n[语音: 我是大肥鱼]\n这句留着')
    expect(segments).toEqual(['我是大肥鱼'])
    expect(text).not.toContain('[语音:')
    expect(text).toContain('说完了。')
    expect(text).toContain('这句留着')
  })

  it('collects several segments in order', () => {
    const { segments } = splitVoiceMarkers('[语音: 第一句] 中间 [语音: 第二句]')
    expect(segments).toEqual(['第一句', '第二句'])
  })

  it('ignores text without markers', () => {
    const { text, segments } = splitVoiceMarkers('纯文字')
    expect(segments).toEqual([])
    expect(text).toBe('纯文字')
  })

  it('round-trips speech through synthesis and recognition', async () => {
    if (!canSynthesize() || !canTranscribe()) return
    const file = await synthesize('我是大肥鱼，不是吃白饭的')
    try {
      const heard = await transcribe(file, 'zh')
      // Recognition is a model output, not a copy: assert it heard the phrase,
      // not that it reproduced every character.
      expect(heard).toContain('大肥鱼')
    } finally {
      rmSync(file, { recursive: true, force: true })
    }
  }, 180_000)

  it('reports whether this deployment has the speech toolchain', () => {
    // Both answers depend on the host, so assert the contract, not a value.
    expect(typeof canSynthesize()).toBe('boolean')
    expect(typeof canTranscribe()).toBe('boolean')
  })
})
