import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import type { DingTalkCredentials } from './dingtalk-credentials'
import { DINGTALK_BOT_TOPIC, dingTalkAck, parseDingTalkFrame } from './dingtalk-message'
import { openDingTalkStream } from './dingtalk-openapi'

const MAX_CALLBACKS_IN_FLIGHT = 32
const PROBE_AFTER_IDLE_MS = 20_000
const PONG_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 15_000

type StreamHooks = {
  admit: (data: string) => Promise<void>
  connected: (online: boolean, problem?: 'credentials' | 'network') => void
}

export async function runDingTalkStream(
  credentials: DingTalkCredentials,
  hooks: StreamHooks,
  signal: AbortSignal
): Promise<void> {
  let backoff = 1_000
  while (!signal.aborted) {
    let problem: 'credentials' | 'network' = 'network'
    try {
      const endpoint = await openDingTalkStream(credentials, signal)
      if (!signal.aborted) {
        await connectDingTalkSocket(endpoint, hooks, signal, () => {
          backoff = 1_000
        })
      }
    } catch (error) {
      // A transport error can contain its ticket or URL.
      if (error instanceof Error && /^dingtalk_http_(400|401|403)$/.test(error.message)) {
        problem = 'credentials'
      }
    }
    if (!signal.aborted) {
      hooks.connected(false, problem)
    }
    await delay(backoff + Math.round(Math.random() * backoff * 0.25), undefined, {
      signal,
      ref: false
    }).catch(() => {})
    backoff = Math.min(backoff * 2, 60_000)
  }
}

export function connectDingTalkSocket(
  endpoint: URL,
  hooks: StreamHooks,
  signal: AbortSignal,
  opened: () => void
): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(endpoint, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: 128 * 1024
    })
    let idleProbe: ReturnType<typeof setTimeout> | undefined
    let pongDeadline: ReturnType<typeof setTimeout> | undefined
    let admitting = 0
    const terminate = () => socket.terminate()
    const noteTraffic = () => {
      clearTimeout(idleProbe)
      clearTimeout(pongDeadline)
      if (!signal.aborted && socket.readyState === WebSocket.OPEN) {
        idleProbe = setTimeout(() => {
          socket.ping()
          pongDeadline = setTimeout(terminate, PONG_TIMEOUT_MS).unref()
        }, PROBE_AFTER_IDLE_MS).unref()
      }
    }
    const send = (ack: string) => {
      if (!signal.aborted && socket.readyState === WebSocket.OPEN) {
        socket.send(ack, (error) => {
          if (error) {
            terminate()
          }
        })
      }
    }
    signal.addEventListener('abort', terminate, { once: true })
    socket.on('error', terminate)
    socket.once('close', () => {
      clearTimeout(idleProbe)
      clearTimeout(pongDeadline)
      signal.removeEventListener('abort', terminate)
      resolve()
    })
    socket.once('open', () => {
      opened()
      hooks.connected(true)
      noteTraffic()
    })
    socket.on('pong', noteTraffic)
    socket.on('ping', noteTraffic)
    socket.on('message', (bytes, binary) => {
      noteTraffic()
      if (binary || signal.aborted) {
        return
      }
      const frame = parseDingTalkFrame(bytes.toString())
      if (!frame) {
        return
      }
      const { type, headers, data } = frame
      if (type === 'SYSTEM') {
        if (headers.topic === 'ping' || headers.topic === 'disconnect') {
          send(dingTalkAck(headers, data))
        }
        if (headers.topic === 'disconnect') {
          socket.close()
        }
        return
      }
      if (headers.topic !== DINGTALK_BOT_TOPIC || admitting >= MAX_CALLBACKS_IN_FLIGHT) {
        return
      }
      admitting++
      void hooks
        .admit(data)
        .then(() =>
          send(
            dingTalkAck(
              { messageId: headers.messageId, contentType: 'application/json' },
              '{"response":{}}'
            )
          )
        )
        .catch(() => {
          // Without a durable write the callback stays unacknowledged for DingTalk to retry.
        })
        .finally(() => {
          admitting--
        })
    })
  })
}
