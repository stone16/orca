import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { writeOwnerOnlyFileDurable } from '../filesystem/owner-only-durable-file-write'
import { DingTalkOwner } from './dingtalk-message'

const MAX_PENDING = 256
const MAX_RECENT = 2_048
const Pending = lazyZodSchema(() => z.object({ id: z.string(), text: z.string() }))
export type DingTalkPending = z.infer<typeof Pending>

const State = lazyZodSchema(() =>
  z.object({
    version: z.literal(1),
    botId: z.string(),
    connectionId: z.uuid(),
    sealedCredentials: z.string(),
    owner: DingTalkOwner.optional(),
    pending: z.array(Pending),
    recent: z.array(z.string()),
    replyAttempt: z.string().optional(),
    replyNeedsReview: z.boolean().optional()
  })
)
export type DingTalkState = z.infer<typeof State>

/** Serializes the durable write that precedes a callback ACK, and credential/owner changes. */
export class DingTalkInbox {
  private readonly file: string
  private readonly loaded: Promise<void>
  private tail = Promise.resolve()
  private saved: DingTalkState | null = null

  constructor(directory: string) {
    this.file = join(directory, 'dingtalk-local', 'state.json')
    this.loaded = this.load()
    void this.loaded.catch(() => {})
  }

  private async load(): Promise<void> {
    const text = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return 'null'
      }
      throw error
    })
    this.saved = State.nullable().parse(JSON.parse(text))
  }

  async read(): Promise<DingTalkState | null> {
    await this.loaded
    await this.tail
    return this.saved
  }

  change(
    change: (state: DingTalkState | null) => DingTalkState | null
  ): Promise<DingTalkState | null> {
    const task = this.tail.then(async () => {
      await this.loaded
      const next = change(this.saved)
      if (next !== this.saved) {
        await writeOwnerOnlyFileDurable(this.file, JSON.stringify(next))
        this.saved = next
      }
      return next
    })
    this.tail = task.then(
      () => {},
      () => {}
    )
    return task
  }
}

export function enqueueDingTalkMessage(
  state: DingTalkState,
  message: DingTalkPending
): DingTalkState {
  if (state.recent.includes(message.id) || state.pending.some(({ id }) => id === message.id)) {
    return state
  }
  if (state.pending.length >= MAX_PENDING) {
    throw new Error('dingtalk_inbox_full')
  }
  return { ...state, pending: [...state.pending, message] }
}

export function settleDingTalkMessage(state: DingTalkState, id: string): DingTalkState {
  return {
    ...state,
    pending: state.pending.filter((entry) => entry.id !== id),
    recent: [...state.recent, id].slice(-MAX_RECENT)
  }
}
