/**
 * Voice support for iMessage delivery, backed by the LAN compute host.
 *
 * Outbound: the agent writes `[语音: 文本]`; the plugin asks the compute host to
 * synthesize speech and sends the audio file, because iMessage renders a real
 * voice note far better than a wall of text.
 *
 * Inbound: an audio attachment is re-encoded locally and transcribed on the
 * compute host, so the model receives words instead of an opaque FileBlock.
 *
 * All speech work runs on the compute host — nothing is synthesized or
 * recognized on this machine. Audio is re-encoded to 16 kHz mono WAV here
 * because the host has no ffmpeg.
 *
 * @module dsh-imessage/voice
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Marker the agent writes to ask for spoken output. */
const VOICE_MARKER = /\[语音:\s*([^\]\n]+?)\s*\]/gu

/** Voice used for synthesized replies (Mandarin, young female). */
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

/** One spoken line, with the direction the agent asked for. */
export interface VoiceSegment {
  text: string
  /** edge-tts rate, e.g. `+10%`. */
  rate?: string
  /** edge-tts pitch, e.g. `+3Hz`. */
  pitch?: string
  /**
   * Performance direction for the expressive engine (Breeze TTS 2): situation,
   * speaking intent, and where the emphasis lands. Its presence selects that
   * engine; without it the line falls back to edge-tts prosody knobs.
   */
  instructions?: string
}

/** How long to wait for the host's health probe before giving up. */
const HEALTH_TIMEOUT_MS = 4000

/** Base URL of the voice service, without a trailing slash. */
function remoteUrl(): string {
  const configured = process.env['DSH_VOICE_URL']
  if (configured !== undefined && configured.length > 0) return configured.replace(/\/+$/u, '')
  return 'http://192.168.10.111:8090'
}

/** Whether the compute host is reachable right now. */
export async function hostAlive(): Promise<boolean> {
  try {
    const response = await fetch(`${remoteUrl()}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}

/** Run one child process and collect stdout, failing on a non-zero exit. */
function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 400)}`))
    })
  })
}

/**
 * Split voice markers out of one outbound text.
 * @param text - the answer as the agent authored it.
 * @returns the text with markers removed, plus the spoken segments in order.
 */
export function splitVoiceMarkers(text: string): { text: string; segments: VoiceSegment[] } {
  const segments: VoiceSegment[] = []
  const stripped = text.replace(VOICE_MARKER, (_match, spoken: string) => {
    // `[语音: 文本 | +10% | +3Hz]` — rate and pitch are optional; a flat voice
    // reads as a machine, so the agent can lift it when the line is playful.
    // Only a token that actually looks like a knob is treated as one: a stray
    // `|` in the sentence must stay in the sentence, never be read aloud.
    const [rawText, second, third] = spoken.split('|').map(part => part.trim())
    const isRate = (value: string | undefined): boolean => value !== undefined && /^[+-]\d+%$/u.test(value)
    const isPitch = (value: string | undefined): boolean => value !== undefined && /^[+-]\d+(?:\.\d+)?Hz$/u.test(value)
    if (rawText === undefined || rawText.length === 0) return ''
    // Second field is either an edge-tts knob or a performance direction.
    const rate = isRate(second) ? second : undefined
    const pitch = isRate(second) && isPitch(third) ? third : undefined
    const instructions = isRate(second) ? undefined : second
    segments.push({
      text: rawText,
      ...(rate === undefined ? {} : { rate }),
      ...(pitch === undefined ? {} : { pitch }),
      ...(instructions === undefined || instructions.length === 0 ? {} : { instructions }),
    })
    return ''
  })
  return { text: stripped, segments }
}

/**
 * Synthesize one line of speech into a temporary MP3 on the compute host.
 * @param text - what to say.
 * @returns absolute path of the audio file; the caller owns cleanup.
 * @throws when the host is unreachable or refuses the request.
 */
export async function synthesize(segment: VoiceSegment): Promise<string> {
  const base = remoteUrl()
  const voiceName = process.env['DSH_VOICE_NAME'] ?? DEFAULT_VOICE
  const params = new URLSearchParams()
  if (segment.instructions !== undefined && segment.instructions.length > 0) {
    // Expressive engine: a performance direction, not prosody knobs.
    params.set('engine', 'breeze')
    params.set('instructions', segment.instructions)
  } else {
    params.set('voice', voiceName)
    if (segment.rate !== undefined) params.set('rate', segment.rate)
    if (segment.pitch !== undefined) params.set('pitch', segment.pitch)
  }
  const response = await fetch(`${base}/tts?${params.toString()}`, {
    method: 'POST',
    body: segment.text,
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    throw new Error(`voice host /tts ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-'))
  const mp3 = join(dir, 'reply.mp3')
  writeFileSync(mp3, Buffer.from(await response.arrayBuffer()))
  // iMessage voice notes are AAC in an MP4 container; a bare MP3 arrives as a
  // one-second stub the phone cannot play.
  const m4a = join(dir, 'reply.m4a')
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', mp3, '-c:a', 'aac', '-b:a', '64k', m4a])
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return m4a
}

/** Re-encode any inbound audio to the 16 kHz mono WAV the recognizer wants. */
async function toWav(path: string): Promise<{ wav: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-wav-'))
  const out = join(dir, 'audio.wav')
  await run('ffmpeg', ['-y', '-v', 'error', '-i', path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out])
  return { wav: out, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Transcribe one audio file to text on the compute host.
 * @param path - absolute path of the audio the sender attached.
 * @param language - optional language hint; omit to let the model detect it.
 * @returns the transcript, or an empty string when nothing was recognized.
 * @throws when the host is unreachable or refuses the request.
 */
export async function transcribe(path: string, language?: string): Promise<string> {
  const { wav, cleanup } = await toWav(path)
  try {
    const query = language !== undefined && language.length > 0 ? `?lang=${encodeURIComponent(language)}` : ''
    const response = await fetch(`${remoteUrl()}/stt${query}`, {
      method: 'POST',
      body: readFileSync(wav),
      signal: AbortSignal.timeout(180_000),
    })
    if (!response.ok) {
      throw new Error(`voice host /stt ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    return (await response.text()).trim()
  } finally {
    cleanup()
  }
}
