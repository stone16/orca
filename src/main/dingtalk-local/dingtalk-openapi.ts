import type { DingTalkCredentials } from './dingtalk-credentials'
import { DINGTALK_BOT_TOPIC } from './dingtalk-message'

const API = 'https://api.dingtalk.com'
const API_TIMEOUT_MS = 15_000

type DingTalkRequests = {
  '/v1.0/gateway/connections/open': DingTalkCredentials & {
    ua: string
    subscriptions: { type: 'CALLBACK'; topic: typeof DINGTALK_BOT_TOPIC }[]
  }
  '/v1.0/oauth2/accessToken': { appKey: string; appSecret: string }
  '/v1.0/robot/oToMessages/batchSend': {
    robotCode: string
    userIds: string[]
    msgKey: 'sampleMarkdown'
    msgParam: string
  }
}

async function post<Path extends keyof DingTalkRequests>(
  path: Path,
  body: DingTalkRequests[Path],
  signal: AbortSignal,
  token?: string
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(token ? { 'x-acs-dingtalk-access-token': token } : {})
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`dingtalk_http_${response.status}`)
  }
  const bodyJson: unknown = await response.json()
  if (!isResponseObject(bodyJson)) {
    throw new Error('dingtalk_invalid_response')
  }
  return bodyJson
}

function isResponseObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function openDingTalkStream(
  credentials: DingTalkCredentials,
  signal: AbortSignal
): Promise<URL> {
  const { endpoint, ticket } = await post(
    '/v1.0/gateway/connections/open',
    {
      ...credentials,
      ua: 'orca-dingtalk',
      subscriptions: [{ type: 'CALLBACK', topic: DINGTALK_BOT_TOPIC }]
    },
    signal
  )
  if (typeof endpoint !== 'string' || typeof ticket !== 'string' || !ticket) {
    throw new Error('dingtalk_invalid_gateway_response')
  }
  const url = new URL(endpoint)
  if (
    url.protocol !== 'wss:' ||
    !url.hostname.endsWith('.dingtalk.com') ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('dingtalk_invalid_stream_endpoint')
  }
  url.searchParams.set('ticket', ticket)
  return url
}

export class DingTalkOpenApi {
  private token: { value: string; expires: number } | undefined

  constructor(private readonly credentials: DingTalkCredentials) {}

  private async accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expires > Date.now()) {
      return this.token.value
    }
    const { accessToken, expireIn } = await post(
      '/v1.0/oauth2/accessToken',
      {
        appKey: this.credentials.clientId,
        appSecret: this.credentials.clientSecret
      },
      signal
    )
    if (
      typeof accessToken !== 'string' ||
      !accessToken ||
      typeof expireIn !== 'number' ||
      expireIn <= 0
    ) {
      throw new Error('dingtalk_invalid_token_response')
    }
    this.token = { value: accessToken, expires: Date.now() + Math.max(0, expireIn - 60) * 1000 }
    return accessToken
  }

  async sendMarkdown(staffId: string, text: string, signal: AbortSignal): Promise<void> {
    const token = await this.accessToken(signal)
    try {
      const reply = await post(
        '/v1.0/robot/oToMessages/batchSend',
        {
          robotCode: this.credentials.clientId,
          userIds: [staffId],
          msgKey: 'sampleMarkdown',
          msgParam: JSON.stringify({ title: 'Orca', text })
        },
        signal,
        token
      )
      const recipientErrors = [
        'invalidStaffIdList',
        'flowControlledStaffIdList',
        'filteredStaffIdList'
      ]
      if (
        typeof reply.processQueryKey !== 'string' ||
        !reply.processQueryKey ||
        recipientErrors.some(
          (key) => reply[key] !== undefined && (!Array.isArray(reply[key]) || reply[key].length)
        )
      ) {
        throw new Error('dingtalk_recipient_not_delivered')
      }
    } catch (error) {
      if (
        error instanceof Error &&
        ['dingtalk_http_401', 'dingtalk_http_403'].includes(error.message)
      ) {
        this.token = undefined
      }
      throw error
    }
  }
}
