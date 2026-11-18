import { describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { hostAlive, splitVoiceMarkers, synthesize, transcribe } from '../src/voice.js'

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

  it('round-trips speech through the compute host', async () => {
    if (!await hostAlive()) return
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

  it('probes the compute host without throwing when it is down', async () => {
    const saved = process.env['DSH_VOICE_URL']
    process.env['DSH_VOICE_URL'] = 'http://127.0.0.1:9'
    try {
      await expect(hostAlive()).resolves.toBe(false)
    } finally {
      if (saved === undefined) delete process.env['DSH_VOICE_URL']
      else process.env['DSH_VOICE_URL'] = saved
    }
  }, 20_000)
})
