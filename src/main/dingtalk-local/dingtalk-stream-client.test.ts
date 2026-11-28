import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { DingTalkInbox, enqueueDingTalkMessage, settleDingTalkMessage } from './dingtalk-inbox'
import { DINGTALK_BOT_TOPIC, parseDingTalkMessage } from './dingtalk-message'
import { connectDingTalkSocket } from './dingtalk-stream-client'

it('ACKs only after durable admission and deduplicates a new-envelope replay across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-dingtalk-'))
  const stop = new AbortController()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const listening = once(server, 'listening')
  const proceed = Promise.withResolvers<void>()
  const admitted = Promise.withResolvers<void>()
  try {
    let inbox = new DingTalkInbox(root)
    await inbox.change(() => ({
      version: 1,
      botId: 'bot',
      connectionId: '2fd0fdb0-10b6-455d-bca3-d6c17c7cce38',
      sealedCredentials: 'test-sealed-blob',
      pending: [],
      recent: []
    }))
    await listening
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('No test socket address')
    }
    const connected = once(server, 'connection')
    const stream = connectDingTalkSocket(
      new URL(`ws://127.0.0.1:${address.port}`),
      {
        connected: () => {},
        admit: async (data) => {
          const message = parseDingTalkMessage(data, 'app-key')!
          admitted.resolve()
          await proceed.promise
          await inbox.change((state) =>
            enqueueDingTalkMessage(state!, { id: message.deliveryId, text: message.text })
          )
        }
      },
      stop.signal,
      () => {}
    )
    const [peer] = await connected
    const callback = (messageId: string) =>
      JSON.stringify({
        specVersion: '1.0',
        type: 'CALLBACK',
        headers: { messageId, topic: DINGTALK_BOT_TOPIC },
        data: JSON.stringify({
          chatbotCorpId: 'org',
          senderCorpId: 'org',
          senderStaffId: 'owner',
          conversationId: 'dm',
          conversationType: '1',
          robotCode: 'app-key',
          msgId: 'unchanged',
          createAt: 2_000,
          msgtype: 'text',
          text: { content: 'Durable request' }
        })
      })
    peer.send(callback('first-envelope'))
    await admitted.promise
    const nextAck = () => once(peer, 'message').then(([bytes]) => JSON.parse(bytes.toString()))
    const pingAck = nextAck()
    peer.send(
      JSON.stringify({
        specVersion: '1.0',
        type: 'SYSTEM',
        headers: {
          topic: 'ping',
          messageId: 'heartbeat'
        },
        data: '{}'
      })
    )
    expect(await pingAck).toMatchObject({ code: 200, headers: { messageId: 'heartbeat' } })
    const firstAck = nextAck()
    proceed.resolve()
    expect(await firstAck).toEqual({
      code: 200,
      headers: { messageId: 'first-envelope', contentType: 'application/json' },
      message: 'OK',
      data: '{"response":{}}'
    })

    inbox = new DingTalkInbox(root)
    const persisted = (await inbox.read())!.pending
    expect(persisted.map(({ text }) => text)).toEqual(['Durable request'])
    await inbox.change((state) => settleDingTalkMessage(state!, persisted[0].id))
    const replayAck = nextAck()
    peer.send(callback('retry-envelope'))
    expect(await replayAck).toMatchObject({ code: 200, headers: { messageId: 'retry-envelope' } })
    expect((await new DingTalkInbox(root).read())?.pending).toEqual([])
    stop.abort()
    await stream
  } finally {
    proceed.resolve()
    stop.abort()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
