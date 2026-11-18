/**
 * Voice support for iMessage delivery.
 *
 * Outbound: the agent writes `[语音: 文本]`; the plugin synthesizes speech with
 * edge-tts and sends the audio file, because iMessage renders a real voice note
 * far better than a wall of text.
 *
 * Inbound: an audio attachment is transcribed with faster-whisper so the model
 * receives words instead of an opaque FileBlock handle.
 *
 * Both directions shell out to a Python virtualenv that carries edge-tts and
 * faster-whisper; the Node side stays dependency-free.
 *
 * @module dsh-imessage/voice
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Marker the agent writes to ask for spoken output. */
const VOICE_MARKER = /\[语音:\s*([^\]\n]+?)\s*\]/gu

/** Voice used for synthesized replies (Mandarin, young female). */
const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'

/** Directory holding the shared Python virtualenv and helper scripts. */
function toolsDir(): string {
  const configured = process.env['DSH_VOICE_TOOLS']
  if (configured !== undefined && configured.length > 0) return configured
  return join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), '..', 'tools')
}

/** Interpreter that has edge-tts and faster-whisper installed. */
function pythonPath(): string {
  const configured = process.env['DSH_VOICE_PYTHON']
  if (configured !== undefined && configured.length > 0) return configured
  return join(toolsDir(), 'tts-venv', 'bin', 'python')
}

/** Whether this deployment can synthesize speech at all. */
export function canSynthesize(): boolean {
  return existsSync(pythonPath())
}

/** Whether this deployment can transcribe audio at all. */
export function canTranscribe(): boolean {
  return existsSync(pythonPath()) && existsSync(join(toolsDir(), 'voice-stt.py'))
}

/** Run one child process and collect stdout, failing on a non-zero exit. */
function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
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
export function splitVoiceMarkers(text: string): { text: string; segments: string[] } {
  const segments: string[] = []
  const stripped = text.replace(VOICE_MARKER, (_match, spoken: string) => {
    segments.push(spoken)
    return ''
  })
  return { text: stripped, segments }
}

/**
 * Synthesize one line of speech into a temporary MP3.
 * @param text - what to say.
 * @returns absolute path of the audio file; the caller owns cleanup.
 */
export async function synthesize(text: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-'))
  const out = join(dir, 'reply.mp3')
  try {
    await run(pythonPath(), [
      '-m', 'edge_tts',
      '--voice', process.env['DSH_VOICE_NAME'] ?? DEFAULT_VOICE,
      '--text', text,
      '--write-media', out,
    ])
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return out
}

/**
 * Transcribe one audio file to text.
 * @param path - absolute path of the audio the sender attached.
 * @param language - optional language hint; omit to let the model detect it.
 * @returns the transcript, or an empty string when nothing was recognized.
 */
export async function transcribe(path: string, language?: string): Promise<string> {
  const args = [join(toolsDir(), 'voice-stt.py'), path]
  if (language !== undefined && language.length > 0) args.push(language)
  const stdout = await run(pythonPath(), args)
  return stdout.trim()
}
