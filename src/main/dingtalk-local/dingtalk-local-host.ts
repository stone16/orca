import { randomUUID } from 'node:crypto'
import type { BotDingTalkPairing, BotDingTalkStatus } from '../../shared/bots/dingtalk-local'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import type { LocalConnectorHost } from '../local-connectors/local-connector-hosts'
import {
  dingTalkSealing,
  sealDingTalkCredentials,
  unsealDingTalkCredentials,
  type DingTalkCredentials
} from './dingtalk-credentials'
import { DingTalkInbox, enqueueDingTalkMessage, type DingTalkState } from './dingtalk-inbox'
import { parseDingTalkMessage } from './dingtalk-message'
import { newDingTalkPairing, routeDingTalkMessage, type DingTalkPairing } from './dingtalk-pairing'
import { DingTalkOpenApi } from './dingtalk-openapi'
import { DingTalkDelivery } from './dingtalk-delivery'

type Connection = {
  id: string
  abort: AbortController
  delivery: DingTalkDelivery
  stream: Promise<void>
}

export class DingTalkLocalHost implements LocalConnectorHost {
  private readonly inbox: DingTalkInbox
  private readonly ready: Promise<void>
  private connected: Connection | undefined
  private pairing: DingTalkPairing | undefined
  private watcher: { seam: ExternalConversationSeam; release: () => void } | undefined
  private online = false
  private connectionProblem: BotDingTalkStatus['connectionProblem'] = null
  private broken = false
  private stopped = false
  private lifecycle = Promise.resolve()

  constructor(
    private readonly runtime: OrcaRuntimeService,
    directory: string,
    private readonly isFenced: () => boolean
  ) {
    this.inbox = new DingTalkInbox(directory)
    this.ready = this.restore().catch(() => {
      this.broken = true
    })
  }

  private async restore(): Promise<void> {
    const state = await this.inbox.read()
    if (state) {
      if (this.runtime.bots.list().some((bot) => bot.id === state.botId)) {
        this.start(state, unsealDingTalkCredentials(state.sealedCredentials))
      } else {
        await this.inbox.change(() => null)
      }
    }
  }

  async status(botId: string): Promise<BotDingTalkStatus> {
    await this.ready
    const sealing = dingTalkSealing().kind
    const state = await this.inbox.read().catch(() => null)
    const link = !state
      ? this.broken
        ? 'unavailable'
        : 'unconfigured'
      : state.botId !== botId
        ? 'another-bot'
        : this.broken
          ? 'unavailable'
          : state.owner
            ? 'paired'
            : 'unpaired'
    return {
      link,
      sealing,
      online: this.online && state?.botId === botId,
      connectionProblem: state?.botId === botId ? this.connectionProblem : null,
      replyNeedsReview: state?.botId === botId && state.replyNeedsReview === true
    }
  }

  configure(botId: string, credentials: DingTalkCredentials): Promise<BotDingTalkStatus> {
    return this.serialize(() => this.saveConnection(botId, credentials))
  }

  private async saveConnection(
    botId: string,
    credentials: DingTalkCredentials
  ): Promise<BotDingTalkStatus> {
    await this.ready
    const sealedCredentials = await sealDingTalkCredentials(credentials)
    const next: DingTalkState = {
      version: 1,
      botId,
      connectionId: randomUUID(),
      sealedCredentials,
      pending: [],
      recent: []
    }
    await this.inbox.change((prior) => {
      if (
        prior ||
        this.stopped ||
        this.isFenced() ||
        !this.runtime.bots.list().some((bot) => bot.id === botId)
      ) {
        throw new Error('dingtalk_connection_unavailable')
      }
      return next
    })
    this.broken = false
    this.start(next, credentials)
    this.changed()
    return this.status(botId)
  }

  async pair(botId: string): Promise<BotDingTalkPairing> {
    await this.ready
    let result: BotDingTalkPairing | undefined
    await this.inbox.change((state) => {
      if (
        state?.botId !== botId ||
        state.owner ||
        this.connected?.id !== state.connectionId ||
        this.isFenced()
      ) {
        throw new Error('dingtalk_pairing_unavailable')
      }
      this.pairing = newDingTalkPairing()
      result = { code: this.pairing.code, expiresAt: this.pairing.expiresAt }
      return state
    })
    return result!
  }

  disconnect(botId: string): Promise<void> {
    return this.serialize(() => this.removeConnection(botId))
  }

  private async removeConnection(botId: string): Promise<void> {
    await this.ready
    let connectionId: string | undefined
    await this.inbox.change((state) => {
      if (state?.botId !== botId) {
        return state
      }
      connectionId = state.connectionId
      return null
    })
    if (connectionId && this.connected?.id === connectionId) {
      await this.stopConnection()
    }
    if (connectionId) {
      this.broken = false
      this.changed()
    }
  }

  repliesFilled(): void {
    this.connected?.delivery.wake()
  }

  botsChanged(): void {
    if (this.stopped) {
      return
    }
    void this.inbox
      .read()
      .then((state) => {
        if (state && !this.runtime.bots.list().some((bot) => bot.id === state.botId)) {
          return this.disconnect(state.botId)
        }
        this.repliesFilled()
        return undefined
      })
      .catch(() => {})
  }

  rewatch(): void {
    this.watcher?.release()
    this.watcher = undefined
    this.repliesFilled()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.stopConnection()
  }

  private async stopConnection(): Promise<void> {
    const connection = this.connected
    this.connected = undefined
    this.pairing = undefined
    this.online = false
    this.connectionProblem = null
    this.watcher?.release()
    this.watcher = undefined
    connection?.abort.abort()
    if (connection) {
      await Promise.allSettled([connection.stream, connection.delivery.stopped()])
    }
  }

  private start(state: DingTalkState, credentials: DingTalkCredentials): void {
    if (this.stopped || this.isFenced()) {
      return
    }
    const id = state.connectionId
    const abort = new AbortController()
    const delivery = new DingTalkDelivery({
      runtime: this.runtime,
      inbox: this.inbox,
      id,
      api: new DingTalkOpenApi(credentials),
      signal: abort.signal,
      watch: (seam) => this.watch(seam),
      changed: () => this.changed()
    })
    this.connected = {
      id,
      abort,
      delivery,
      stream: import('./dingtalk-stream-client')
        .then(({ runDingTalkStream }) =>
          runDingTalkStream(
            credentials,
            {
              admit: (data) => this.admit(data, credentials.clientId, id),
              connected: (online, error) => {
                const problem = error ?? null
                if (
                  this.connected?.id === id &&
                  (this.online !== online || this.connectionProblem !== problem)
                ) {
                  this.online = online
                  this.connectionProblem = problem
                  this.changed()
                }
              }
            },
            abort.signal
          )
        )
        .catch(() => {
          if (this.connected?.id === id) {
            this.broken = true
            this.changed()
          }
        })
    }
    delivery.wake()
  }

  private async admit(data: string, clientId: string, id: string): Promise<void> {
    const message = parseDingTalkMessage(data, clientId)
    if (!message || !this.runtime.bots.enabled() || this.isFenced()) {
      return
    }
    let paired = false
    const saved = await this.inbox.change((state) => {
      if (
        state?.connectionId !== id ||
        !this.runtime.bots.list().some((bot) => bot.id === state.botId)
      ) {
        return state
      }
      switch (routeDingTalkMessage(state.owner, this.pairing, message)) {
        case 'pair':
          paired = true
          return { ...state, owner: message.owner }
        case 'queue':
          return enqueueDingTalkMessage(state, { id: message.deliveryId, text: message.text })
        case 'ignore':
          return state
      }
    })
    if (paired) {
      this.pairing = undefined
      this.changed()
    }
    if (saved?.connectionId === id && saved.owner) {
      this.repliesFilled()
    }
  }

  private watch(seam: ExternalConversationSeam): void {
    if (this.watcher?.seam === seam || this.stopped) {
      return
    }
    this.watcher?.release()
    this.watcher = { seam, release: seam.watch(runtimeConversationHost(this.runtime), () => {}) }
  }

  private changed(): void {
    if (!this.stopped && !this.isFenced()) {
      this.runtime.notifyBotsChanged({ kinds: ['settings', 'bot'] })
    }
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const task = this.lifecycle.then(operation)
    this.lifecycle = task.then(
      () => {},
      () => {}
    )
    return task
  }
}
