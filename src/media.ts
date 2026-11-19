/**
 * Media normalization for inbound attachments.
 *
 * iPhone photos arrive as HEIC/HEIF, which DSH's image pipeline (sharp) does
 * not accept — handing the raw bytes to `saveImage` throws and the picture
 * never reaches the model. Converting once here keeps iPhone users from having
 * to remember to switch their camera format.
 *
 * The converter is the system ImageMagick (`convert`/`magick`, built with
 * libheif). When it is missing the caller falls back to storing the file
 * verbatim and says so, instead of failing the whole turn.
 *
 * @module dsh-imessage/media
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** HEIC/HEIF sniffing for both MIME types and file names. */
const HEIC = /heic|heif/iu

/**
 * @param mimeType - declared MIME type, possibly empty.
 * @returns whether the payload must be converted before entering DSH.
 */
export function isHeic(mimeType: string | undefined): boolean {
  return mimeType !== undefined && HEIC.test(mimeType)
}

/**
 * Rename a `.heic`/`.heif` attachment so the stored file matches its new bytes.
 * @param name - original attachment name, if any.
 * @returns the renamed file, or the original name when it is not HEIC.
 */
export function jpegName(name: string | undefined): string | undefined {
  if (name === undefined || !HEIC.test(name)) return name
  return name.replace(/\.(heic|heif)$/iu, '.jpg')
}

/** Run one command and reject on a non-zero exit. */
function run(command: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 300)}`))
    })
  })
}

/** Locate an ImageMagick binary, preferring the absolute path when present. */
function converter(): string {
  if (existsSync('/usr/bin/convert')) return '/usr/bin/convert'
  if (existsSync('/usr/bin/magick')) return '/usr/bin/magick'
  return 'convert'
}

/**
 * Convert a HEIC/HEIF photo to JPEG.
 * @param data - raw HEIC bytes.
 * @returns JPEG bytes (EXIF orientation applied, metadata stripped).
 * @throws when ImageMagick is missing or refuses the file.
 */
export async function heicToJpeg(data: Uint8Array): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-imesg-heic-'))
  const src = join(dir, 'in.heic')
  const dst = join(dir, 'out.jpg')
  try {
    writeFileSync(src, data)
    await run(converter(), [src, '-auto-orient', '-strip', '-quality', '88', dst], 30_000)
    return new Uint8Array(readFileSync(dst))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
