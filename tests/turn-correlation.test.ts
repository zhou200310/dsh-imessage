import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SpectrumInboundMessage } from '../src/spectrum-runtime.js'
import { TurnCorrelation } from '../src/turn-correlation.js'

function agent(id: string): Agent {
  return { id } as Agent
}

function channel(): SpectrumInboundMessage {
  return {
    id: 'provider-message',
    text: 'prompt',
    responding: async callback => callback(),
    send: vi.fn(async () => {}),
  }
}

describe('exact iMessage turn correlation', () => {
  it('ignores browser and wrong-session activity before returning only the owned final answer', async () => {
    const correlation = new TurnCorrelation()
    const selected = agent('session-a')
    const dm = channel()
    let settled = false
    const result = correlation.begin(selected, 'user-message-a', dm)
      .finally(() => { settled = true })

    correlation.claim(selected, 'browser-user-message', 1)
    correlation.assistant('session-a', 1, 'browser answer')
    correlation.end('session-a', 1)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(correlation.owns(selected)).toBe(false)

    correlation.claim(selected, 'user-message-a', 2)
    expect(correlation.owns(selected)).toBe(true)
    expect(correlation.channelFor(selected)).toBe(dm)
    correlation.assistant('session-b', 2, 'wrong session')
    correlation.assistant('session-a', 99, 'wrong turn')
    correlation.end('session-b', 2)
    await Promise.resolve()
    expect(settled).toBe(false)

    correlation.assistant('session-a', 2, 'draft final')
    correlation.assistant('session-a', 2, 'actual final')
    correlation.end('session-a', 2)
    await expect(result).resolves.toEqual({ text: 'actual final', attachments: [] })
    expect(correlation.owns(selected)).toBe(false)
  })

  it('does not let another Agent claim a registered message id', async () => {
    const correlation = new TurnCorrelation()
    const selected = agent('session-a')
    const other = agent('session-b')
    let settled = false
    const result = correlation.begin(selected, 'message', channel())
      .finally(() => { settled = true })
    correlation.claim(other, 'message', 1)
    correlation.end('session-b', 1)
    await Promise.resolve()
    expect(settled).toBe(false)
    correlation.discard(selected, 'message')
    await expect(result).rejects.toMatchObject({ code: 'runtime-failed' })
  })

  it('fails every pending wait when an Agent is disposed', async () => {
    const correlation = new TurnCorrelation()
    const selected = agent('session-a')
    const unclaimed = correlation.begin(selected, 'one', channel())
    const claimed = correlation.begin(selected, 'two', channel())
    correlation.claim(selected, 'two', 2)
    correlation.disposeAgent(selected)
    await expect(unclaimed).rejects.toThrow('before claiming')
    await expect(claimed).rejects.toThrow('before answering')
  })

  it('cancels only unclaimed prompts for one exact Agent', async () => {
    const correlation = new TurnCorrelation()
    const selected = agent('session-a')
    const other = agent('session-b')
    const selectedWait = correlation.begin(selected, 'selected-message', channel())
    const otherWait = correlation.begin(other, 'other-message', channel())
    const stopped = new Error('stopped')

    expect(correlation.cancelUnclaimed(selected, stopped)).toEqual(['selected-message'])
    await expect(selectedWait).rejects.toBe(stopped)
    correlation.discard(other, 'other-message')
    await expect(otherWait).rejects.toMatchObject({ code: 'runtime-failed' })
  })
  it('carries the attachments the owned turn produced alongside its text', async () => {
    const correlation = new TurnCorrelation()
    const selected = agent('session-a')
    const result = correlation.begin(selected, 'with-image', channel())
    correlation.claim(selected, 'with-image', 7)

    const image = {
      attachmentId: 'sha256:image' as never,
      mediaType: 'image/png' as const,
      bytes: 12,
      width: 4,
      height: 3,
    }
    const file = { attachmentId: 'sha256:file' as never, name: 'report.pdf', bytes: 99 }
    correlation.assistant('session-a', 7, 'here you go', [image, file])
    correlation.end('session-a', 7)

    await expect(result).resolves.toEqual({
      text: 'here you go',
      attachments: [image, file],
    })
  })

  it('resolves attachment-only turns without inventing text', async () => {
    const correlation = new TurnCorrelation()
    const selected = agent('session-a')
    const result = correlation.begin(selected, 'image-only', channel())
    correlation.claim(selected, 'image-only', 8)
    const image = {
      attachmentId: 'sha256:only' as never,
      mediaType: 'image/jpeg' as const,
      bytes: 8,
      width: 2,
      height: 2,
    }
    correlation.assistant('session-a', 8, '', [image])
    correlation.end('session-a', 8)

    await expect(result).resolves.toEqual({ attachments: [image] })
  })
})
