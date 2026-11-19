import { Spectrum, type ContentInput, type PlatformProviderConfig, type SpectrumInstance } from '@spectrum-ts/core'
import { imessage } from '@spectrum-ts/imessage'
import { PluginError } from './errors.js'
import type { RuntimeView } from './types.js'

/** Recipient marker emitted by Spectrum 12.7 for project-scoped shared lines. */
const SPECTRUM_SHARED_PHONE = 'shared'

/** Credentials required to discover and connect the project's hosted line. */
export interface SpectrumConnectionConfig {
  /** Photon project id. */
  projectId: string
  /** Host-only Spectrum project secret. */
  projectSecret: string
  /** Authorized originating E.164 number. */
  senderPhoneNumber: string
  /** Assigned hosted recipient E.164 number. */
  assignedPhoneNumber: string
}

/** Text-only inbound message accepted by the security filter. */
/** Raster media types the DSH attachment store admits as images (ImageBlock). */
export const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** One inbound attachment decoded from a provider message. */
export interface InboundAttachment {
  /** Raw encoded bytes as received. */
  data: Uint8Array
  /** Declared media type; drives whether this becomes an ImageBlock or a FileBlock. */
  mimeType: string
  /** Provider display name, never interpreted as a path. */
  name?: string
}

export interface SpectrumInboundMessage {
  /** Durable provider message id. */
  id: string
  /** Plain inbound text (empty for an attachment-only message). */
  text: string
  /** Inbound attachments carried by this message, in provider order. */
  attachments?: readonly InboundAttachment[]
  /** Run work while Spectrum maintains typing state. */
  responding<T>(callback: () => Promise<T>): Promise<T>
  /** Send text or an attachment to the same DM. */
  send(content: ContentInput): Promise<void>
}

/** Running Spectrum connection behind an injectable adapter seam. */
export interface SpectrumConnection {
  /** Accepted inbound text-only messages. */
  messages: AsyncIterable<SpectrumInboundMessage>
  /** Stop and release provider resources. */
  stop(): Promise<void>
}

/** Injectable Spectrum connection factory. */
export type SpectrumConnectionFactory = (config: SpectrumConnectionConfig) => Promise<SpectrumConnection>

/** Supervisor callbacks. */
export interface SpectrumSupervisorOptions {
  /** Initial reconnect delay in milliseconds. */
  reconnectMinMs: number
  /** Maximum reconnect delay in milliseconds. */
  reconnectMaxMs: number
  /** Called for every public runtime transition. */
  onState(state: RuntimeView): void
  /** Called for every accepted inbound text message. */
  onMessage(message: SpectrumInboundMessage): Promise<void>
  /** Random source used for reconnect jitter. */
  random?: () => number
  /** Clock used for public state timestamps. */
  now?: () => number
}

/** Serialized Spectrum stop/start lifecycle with bounded exponential reconnect. */
export class SpectrumSupervisor {
  private readonly random: () => number
  private readonly now: () => number
  private desired: SpectrumConnectionConfig | undefined
  private connection: SpectrumConnection | undefined
  private operation = Promise.resolve()
  private generation = 0
  private reconnectAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private stateValue: RuntimeView = { phase: 'stopped' }

  /** Construct one listener supervisor. */
  constructor(
    private readonly factory: SpectrumConnectionFactory,
    private readonly options: SpectrumSupervisorOptions,
  ) {
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
  }

  /** Current public listener health. */
  get state(): RuntimeView {
    return this.stateValue
  }

  /** Whether interaction delivery is healthy enough to claim DSH prompts. */
  get healthy(): boolean {
    return this.stateValue.phase === 'listening'
  }

  /** Open and validate a replacement connection without disturbing the active listener. */
  prepare(config: SpectrumConnectionConfig): Promise<SpectrumConnection> {
    return this.factory({ ...config })
  }

  /** Atomically adopt a prepared listener, then release the previous one. */
  activate(config: SpectrumConnectionConfig, connection: SpectrumConnection): Promise<void> {
    return this.enqueue(async () => {
      this.desired = { ...config }
      this.reconnectAttempt = 0
      if (this.retryTimer !== undefined) {
        clearTimeout(this.retryTimer)
        this.retryTimer = undefined
      }
      const previous = this.connection
      const generation = ++this.generation
      this.connection = connection
      this.publish({ phase: 'listening', connectedAt: this.now() })
      void this.consume(connection, generation)
      if (previous !== undefined && previous !== connection) {
        try {
          await previous.stop()
        } catch {
          // The generation gate already prevents the previous stream from routing.
        }
      }
    })
  }

  /** Atomically replace the desired configuration and restart the listener. */
  restart(config: SpectrumConnectionConfig): Promise<void> {
    this.desired = { ...config }
    this.reconnectAttempt = 0
    return this.enqueue(async () => {
      await this.stopCurrent(false)
      await this.startCurrent()
    })
  }

  /** Retry the current configuration immediately. */
  retry(): Promise<void> {
    if (this.desired === undefined) {
      return Promise.reject(new PluginError('runtime-failed', 'Provision a phone number before starting iMessage.'))
    }
    this.reconnectAttempt = 0
    return this.enqueue(async () => {
      await this.stopCurrent(false)
      await this.startCurrent()
    })
  }

  /** Stop local routing while preserving Photon cloud resources. */
  stop(): Promise<void> {
    this.desired = undefined
    return this.enqueue(async () => {
      await this.stopCurrent(true)
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operation.then(operation, operation)
    this.operation = result.catch(() => {})
    return result
  }

  private async startCurrent(): Promise<void> {
    const config = this.desired
    if (config === undefined) {
      this.publish({ phase: 'stopped' })
      return
    }
    const generation = ++this.generation
    this.publish({ phase: 'starting' })
    try {
      const connection = await this.factory(config)
      if (generation !== this.generation || this.desired === undefined) {
        await connection.stop()
        return
      }
      this.connection = connection
      this.reconnectAttempt = 0
      this.publish({ phase: 'listening', connectedAt: this.now() })
      void this.consume(connection, generation)
    } catch (error) {
      if (generation !== this.generation || this.desired === undefined) return
      this.scheduleReconnect(error)
    }
  }

  private async consume(connection: SpectrumConnection, generation: number): Promise<void> {
    try {
      for await (const message of connection.messages) {
        if (generation !== this.generation || connection !== this.connection) return
        try {
          await this.options.onMessage(message)
        } catch {
          // A DSH turn or outbound send failure must not terminate Spectrum's receive stream.
        }
      }
      if (generation === this.generation && connection === this.connection && this.desired !== undefined) {
        await this.retireAndReconnect(connection, generation, new Error('Spectrum message stream ended'))
      }
    } catch (error) {
      if (generation === this.generation && connection === this.connection && this.desired !== undefined) {
        await this.retireAndReconnect(connection, generation, error)
      }
    }
  }

  private async retireAndReconnect(
    connection: SpectrumConnection,
    generation: number,
    error: unknown,
  ): Promise<void> {
    this.connection = undefined
    try {
      await connection.stop()
    } catch {
      // The failed stream is already fenced by identity and generation.
    }
    if (generation === this.generation && this.desired !== undefined) this.scheduleReconnect(error)
  }

  private scheduleReconnect(_error: unknown): void {
    if (this.desired === undefined) return
    const attempt = ++this.reconnectAttempt
    const exponential = Math.min(
      this.options.reconnectMaxMs,
      this.options.reconnectMinMs * 2 ** Math.min(attempt - 1, 20),
    )
    const jittered = Math.max(1, Math.round(exponential * (0.75 + this.random() * 0.5)))
    const retryAt = this.now() + jittered
    this.publish({ phase: 'retrying', attempt, retryAt })
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.enqueue(() => this.startCurrent()).catch(() => {
        this.publish({
          phase: 'failed',
          error: { code: 'runtime-failed', message: 'The iMessage listener could not restart.' },
        })
      })
    }, jittered)
  }

  private async stopCurrent(clearState: boolean): Promise<void> {
    this.generation += 1
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    const connection = this.connection
    this.connection = undefined
    if (connection !== undefined) {
      try {
        await connection.stop()
      } catch {
        // Teardown remains best-effort; the generation gate prevents further routing.
      }
    }
    if (clearState) this.publish({ phase: 'stopped' })
  }

  private publish(state: RuntimeView): void {
    this.stateValue = state
    this.options.onState(state)
  }
}

/** Build a production Spectrum 12.7 connection with hosted-line discovery. */
export const createSpectrumConnection: SpectrumConnectionFactory = async config => {
  // Spectrum 12.7.0's separately-published iMessage declaration loses its
  // PlatformDef constraint through an Omit. Keep that compatibility cast at
  // this single package boundary; runtime values follow the documented API.
  const provider = (imessage.config as unknown as () => PlatformProviderConfig)()
  const app = await Spectrum({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    providers: [provider],
    telemetry: false,
    options: { logLevel: 'warn', flattenGroups: true },
  })
  return adaptSpectrum(app, config)
}

/** Pure inbound policy used by the production adapter and replay tests. */
export function acceptsInboundMessage(
  raw: {
    id?: unknown
    platform?: unknown
    direction?: unknown
    content?: unknown
    sender?: unknown
    space?: unknown
  },
  config: Pick<SpectrumConnectionConfig, 'senderPhoneNumber' | 'assignedPhoneNumber'>,
): raw is {
  id: string
  platform: 'imessage'
  direction: 'inbound'
  content:
    | { type: 'text'; text: string }
    | { type: 'attachment'; mimeType: string; name: string; read: () => Promise<Buffer> }
    | { type: 'voice'; mimeType: string; name?: string; read: () => Promise<Buffer> }
  sender: { id?: string; address?: string; service?: string }
  space: { type: 'dm'; phone: string }
} {
  if (raw.platform !== 'imessage' || raw.direction !== 'inbound' || typeof raw.id !== 'string') return false
  if (!raw.content || typeof raw.content !== 'object') return false
  const content = raw.content as Record<string, unknown>
  const contentType = content['type']
  const isText = contentType === 'text' && typeof content['text'] === 'string'
  // iMessage delivers a recorded voice note as `voice`, not `attachment`.
  const isAttachment = (contentType === 'attachment' || contentType === 'voice')
    && typeof content['mimeType'] === 'string'
  if (!isText && !isAttachment) return false
  if (!raw.sender || typeof raw.sender !== 'object') return false
  const sender = raw.sender as Record<string, unknown>
  const address = typeof sender['address'] === 'string'
    ? sender['address']
    : typeof sender['id'] === 'string' ? sender['id'] : undefined
  if (address !== config.senderPhoneNumber) return false
  if (sender['service'] !== undefined && sender['service'] !== 'iMessage') return false
  if (!raw.space || typeof raw.space !== 'object') return false
  const space = raw.space as Record<string, unknown>
  if (space['type'] !== 'dm') return false

  // Spectrum cannot expose the recipient on shared-token inbound records and
  // deliberately tags their project-scoped route as "shared". The exact sender
  // and service checks above remain mandatory; dedicated routes still require
  // the configured assigned number.
  const routedPhone = space['phone']
  return routedPhone === config.assignedPhoneNumber || routedPhone === SPECTRUM_SHARED_PHONE
}

function adaptSpectrum(
  app: SpectrumInstance,
  config: SpectrumConnectionConfig,
): SpectrumConnection {
  return {
    messages: mapMessages(app, config),
    stop: () => app.stop(),
  }
}

/** Upper bound for one attachment transfer; big enough for a 4K photo, short
 * enough that a dead link does not freeze the whole inbound stream. */
const ATTACHMENT_READ_TIMEOUT_MS = 30_000

/** Race a promise against a hard timeout so a hung read cannot stall forever. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The slice of Spectrum attachment content this module actually touches. */
interface ReadableContent {
  readonly type: string
  readonly mimeType?: string | undefined
  readonly size?: number | undefined
  read(): Promise<unknown>
  stream?: (() => Promise<AsyncIterable<unknown>>) | undefined
}

/** Normalize whatever the SDK handed back into bytes. */
function toBuffer(value: unknown): Buffer | undefined {
  if (value === undefined || value === null) return undefined
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  const sized = value as { length?: number }
  if (typeof sized.length === 'number') return Buffer.from(value as ArrayLike<number>)
  return undefined
}

/**
 * Read one inbound attachment, falling back to the chunked stream API.
 * @param content - the Spectrum message content to decode.
 * @returns raw bytes, or undefined when every path failed.
 */
async function readAttachmentBytes(
  content: ReadableContent,
): Promise<Buffer | undefined> {
  const declared = typeof content.size === 'number' ? content.size : undefined
  console.log('[imesg-diag] attachment size:', declared ?? 'unknown', 'mime:', content.mimeType)
  let firstError: unknown
  try {
    const value = await withTimeout(content.read(), ATTACHMENT_READ_TIMEOUT_MS, 'read()')
    const bytes = toBuffer(value)
    console.log('[imesg] read() ok:', bytes?.length ?? 0, 'bytes')
    return bytes
  } catch (error) {
    firstError = error
    console.error('[imesg] read() failed:', error instanceof Error ? error.message : String(error))
  }
  const openStream = content.stream
  if (typeof openStream === 'function') {
    try {
      const joined = await withTimeout((async () => {
        const chunks: Buffer[] = []
        const stream = await openStream()
        for await (const chunk of stream) {
          const part = toBuffer(chunk)
          if (part !== undefined) chunks.push(part)
        }
        return chunks.length > 0 ? Buffer.concat(chunks) : undefined
      })(), ATTACHMENT_READ_TIMEOUT_MS, 'stream()')
      if (joined !== undefined) {
        console.log('[imesg] stream() recovered:', joined.length, 'bytes')
        return joined
      }
      console.error('[imesg] stream() returned 0 bytes')
    } catch (error) {
      console.error('[imesg] stream() failed:', error instanceof Error ? error.message : String(error))
    }
  }
  console.error('[imesg] inbound media unreadable:', content.type, content.mimeType,
    firstError instanceof Error ? firstError.message : String(firstError))
  return undefined
}

async function* mapMessages(
  app: SpectrumInstance,
  config: SpectrumConnectionConfig,
): AsyncIterable<SpectrumInboundMessage> {
  for await (const [space, message] of app.messages) {
    if (!acceptsInboundMessage(message, config)) continue
    const content = message.content
    let text = ''
    let attachments: InboundAttachment[] | undefined
    if (content.type === 'text') {
      text = content.text
    } else {
      console.log('[imesg-diag] inbound media:', content.type, content.mimeType)
      // Attachment-only message: decode every attachment so the router can store it
      // as an ImageBlock (raster) or a FileBlock (anything else).
      //
      // Spectrum's read() pulls the whole payload over gRPC in one shot and a
      // multi-megabyte iPhone photo regularly gets cut off mid-transfer, so a
      // plain await either hangs the message stream or throws. Bound it, retry
      // through stream(), and if both paths fail keep the turn alive with a
      // placeholder instead of swallowing the message.
      const buffer = await readAttachmentBytes(content)
      if (buffer === undefined) {
        text = `[${content.type} ${content.mimeType ?? ''} 接收失败：附件读取中断，请重发或改发截图]`.trim()
      } else {
        const name = content.name
        attachments = [{
          data: new Uint8Array(buffer),
          mimeType: content.mimeType,
          ...(name === undefined || name.length === 0 ? {} : { name }),
        }]
      }
    }
    yield {
      id: message.id,
      text,
      ...(attachments === undefined ? {} : { attachments }),
      responding: callback => space.responding(callback),
      send: async (value) => {
        await space.send(value)
      },
    }
  }
}
