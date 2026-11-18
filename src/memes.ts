/**
 * Meme-pack lookup for outbound iMessage delivery.
 *
 * The Web client renders `[表情: caption]` markers into images itself, so the
 * agent never emits an image block for a meme. Over iMessage that marker would
 * arrive as literal text. This module resolves the same marker against the
 * shared meme-pack library so the plugin can send the actual image instead.
 *
 * @module dsh-imessage/memes
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** One meme resolved to a file on disk. */
export interface ResolvedMeme {
  /** Absolute path of the image file. */
  file: string
  /** Caption recorded in the pack index. */
  caption: string
}

/** Matches one `[表情: …]` marker and captures its caption. */
const MEME_MARKER = /\[表情:\s*([^\]\n]+?)\s*\]/gu

/** Home of the DSH profile, honouring DSH_HOME when a deployment overrides it. */
function dshHome(): string {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/** Directories of the packs the user has enabled, in preference order. */
function enabledPackDirs(): string[] {
  const root = join(dshHome(), 'meme-packs')
  const usable = (dir: string): boolean => existsSync(join(dir, 'index.db'))

  let ids: string[] = []
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome(), 'dsh-expression.json'), 'utf8')) as {
      enabledPacks?: unknown
    }
    if (Array.isArray(parsed.enabledPacks)) {
      ids = parsed.enabledPacks.filter((value): value is string => typeof value === 'string')
    }
  } catch {
    // No settings file: fall back to every pack that carries an index.
  }
  if (ids.length > 0) {
    return ids.map(id => join(root, id)).filter(usable)
  }
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name))
      .filter(usable)
  } catch {
    return []
  }
}

/** Look up one caption across the enabled packs; exact match wins over a substring. */
export function resolveMeme(caption: string): ResolvedMeme | undefined {
  const wanted = caption.trim()
  if (wanted.length === 0) return undefined
  for (const dir of enabledPackDirs()) {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(join(dir, 'index.db'), { readOnly: true })
      const exact = db
        .prepare('SELECT path, caption FROM memes WHERE caption = ? LIMIT 1')
        .get(wanted) as { path: string; caption: string } | undefined
      const hit = exact ?? db
        .prepare('SELECT path, caption FROM memes WHERE caption LIKE ? LIMIT 1')
        .get(`%${wanted}%`) as { path: string; caption: string } | undefined
      if (hit !== undefined) {
        const file = join(dir, hit.path)
        if (existsSync(file)) return { file, caption: hit.caption }
      }
    } catch (error) {
      console.error('[imesg] meme pack unreadable:', dir,
        error instanceof Error ? error.message : String(error))
    } finally {
      db?.close()
    }
  }
  return undefined
}

/**
 * Split meme markers out of one outbound text.
 * @param text - the answer as the agent authored it.
 * @returns the text with markers removed, plus the captions in emission order.
 */
export function splitMemeMarkers(text: string): { text: string; captions: string[] } {
  const captions: string[] = []
  const stripped = text.replace(MEME_MARKER, (_match, caption: string) => {
    captions.push(caption)
    return ''
  })
  return { text: stripped, captions }
}
