import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { outcomeSentence } from '../connector-cloud/connector-reply-outcome-sentence'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { settleDingTalkMessage, type DingTalkInbox, type DingTalkState } from './dingtalk-inbox'
import type { DingTalkOwner } from './dingtalk-message'
import type { DingTalkOpenApi } from './dingtalk-openapi'

const RETRY_MS = 5_000
const MARKDOWN_CHARS = 4_000
const RETRYABLE_REFUSALS = new Set([
  'bot_paused',
  'agent_not_reachable',
  'delivery_backlog_full',
  'connectors_disabled'
])

/** Leave the bytes intact, preferring line breaks and keeping a UTF-16 pair together. */
export function splitDingTalkMarkdown(text: string): string[] {
  const parts: string[] = []
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(text.length, offset + MARKDOWN_CHARS)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1)
      if (newline >= offset + MARKDOWN_CHARS / 2) {
        end = newline + 1
      } else {
        const next = text.charCodeAt(end)
        const previous = text.charCodeAt(end - 1)
        if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          end--
        }
      }
    }
    parts.push(text.slice(offset, end))
    offset = end
  }
  return parts
}

type PairedState = DingTalkState & { owner: DingTalkOwner }

export class DingTalkDelivery {
  private running: Promise<void> | undefined
  private again = false
  private retry: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly options: {
      runtime: OrcaRuntimeService
      inbox: DingTalkInbox
      id: string
      api: DingTalkOpenApi
      signal: AbortSignal
      watch: (seam: ExternalConversationSeam) => void
      changed: () => void
    }
  ) {}

  wake(): void {
    if (this.options.signal.aborted) {
      return
    }
    if (this.running) {
      this.again = true
      return
    }
    clearTimeout(this.retry)
    this.again = false
    this.running = this.drain()
      .catch(() => this.retryLater())
      .finally(() => {
        this.running = undefined
        if (this.again) {
          this.wake()
        }
      })
  }

  async stopped(): Promise<void> {
    clearTimeout(this.retry)
    await this.running
  }

  private retryLater(): void {
    clearTimeout(this.retry)
    if (!this.options.signal.aborted) {
      this.retry = setTimeout(() => this.wake(), RETRY_MS)
      this.retry.unref()
    }
  }

  private async drain(): Promise<void> {
    const { runtime, inbox, id, signal, watch } = this.options
    const state = await inbox.read()
    if (state?.connectionId !== id || !state.owner || signal.aborted) {
      return
    }
    if (!runtime.bots.enabled()) {
      this.retryLater()
      return
    }
    const bot = runtime.bots.list().find(({ id: botId }) => botId === state.botId)
    if (!bot) {
      return
    }
    await runtime.ensureStructuredAgentSessionHost()
    const seam = runtime.getExternalConversationSeam()
    if (!seam || signal.aborted) {
      this.retryLater()
      return
    }
    watch(seam)
    const host = runtimeConversationHost(runtime)
    const conversation = { source: 'dingtalk', externalId: id } as const
    const account = `dingtalk:${id}`
    for (const message of state.pending) {
      signal.throwIfAborted()
      const { initial } = await seam.start(host, conversation, message.id, {
        agent: bot.agent,
        target: { kind: 'bot', botId: bot.id },
        prompt: message.text,
        asker: {
          userId: id,
          role: 'owner',
          place: { kind: 'direct_message', id },
          text: message.text,
          context: []
        },
        reply: { account },
        storedImages: [],
        transportSignal: signal
      })
      if (initial.outcome === 'refused' && RETRYABLE_REFUSALS.has(initial.reason)) {
        this.retryLater()
        break
      }
      await this.update((current) => settleDingTalkMessage(current, message.id))
    }
    const journal = getStructuredAgentSessionHost()?.deps.store.connectorReplies()
    if (journal) {
      await this.sendReplies({ ...state, owner: state.owner }, journal, account)
    }
  }

  private update(change: (state: DingTalkState) => DingTalkState): Promise<DingTalkState | null> {
    const { inbox, id } = this.options
    return inbox.change((state) => (state?.connectionId === id ? change(state) : state))
  }

  private async sendReplies(
    state: PairedState,
    journal: ConnectorReplyJournal,
    account: string
  ): Promise<void> {
    const { id, signal } = this.options
    if (state.replyAttempt) {
      await journal.sent([{ account, deliveryId: state.replyAttempt }])
      await this.finishReply(false)
    }
    for (;;) {
      signal.throwIfAborted()
      const rows = await journal.readOwed(account, null, 50)
      if (!rows.length) {
        return
      }
      for (const row of rows) {
        signal.throwIfAborted()
        if (
          row.conversation.source !== 'dingtalk' ||
          row.conversation.externalId !== id ||
          !row.fill
        ) {
          throw new Error('dingtalk_reply_wrong_conversation')
        }
        await this.sendReply(row, state.owner, journal)
      }
    }
  }

  private async sendReply(
    row: JournalConnectorReplyRow,
    owner: DingTalkOwner,
    journal: ConnectorReplyJournal
  ): Promise<void> {
    const { api, signal, id } = this.options
    const fill = row.fill!
    const key = { account: row.account, deliveryId: row.deliveryId }
    if (fill.outcome === 'quiet' || fill.answerDeliveryId !== row.deliveryId) {
      await journal.sent([key])
      return
    }
    const text = fill.prose || outcomeSentence(fill.outcome, 'Orca', fill.toolsRan)
    const claimed = await this.update((state) => ({ ...state, replyAttempt: row.deliveryId }))
    if (claimed?.connectionId !== id || signal.aborted) {
      return
    }
    // Claim before any POST. A saved attempt with no result can have delivered on the other end.
    await journal.sent([key])
    let delivered = false
    try {
      for (const part of splitDingTalkMarkdown(text)) {
        signal.throwIfAborted()
        await api.sendMarkdown(owner.staffId, part, signal)
      }
      delivered = true
    } finally {
      await this.finishReply(delivered)
    }
  }

  private async finishReply(delivered: boolean): Promise<void> {
    await this.update((state) => ({
      ...state,
      replyAttempt: undefined,
      replyNeedsReview: !!state.replyNeedsReview || !delivered
    }))
    this.options.changed()
  }
}
