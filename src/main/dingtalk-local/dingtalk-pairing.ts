import { randomBytes, timingSafeEqual } from 'node:crypto'
import { sameDingTalkOwner, type DingTalkMessage, type DingTalkOwner } from './dingtalk-message'

export type DingTalkPairing = { code: string; issuedAt: number; expiresAt: number }
const PAIRING_TTL_MS = 5 * 60 * 1000

export function newDingTalkPairing(issuedAt = Date.now()): DingTalkPairing {
  const code = randomBytes(6).toString('hex').toUpperCase()
  return { code, issuedAt, expiresAt: issuedAt + PAIRING_TTL_MS }
}

function matchesDingTalkPairing(
  pairing: DingTalkPairing | undefined,
  message: DingTalkMessage,
  now = Date.now()
): boolean {
  const candidate = /^\/pair ([\dA-F]{12})$/i.exec(message.text.trim())?.[1]
  return Boolean(
    candidate &&
    pairing &&
    now < pairing.expiresAt &&
    message.createdAt >= pairing.issuedAt &&
    message.createdAt < pairing.expiresAt &&
    timingSafeEqual(Buffer.from(pairing.code), Buffer.from(candidate.toUpperCase()))
  )
}

export function routeDingTalkMessage(
  owner: DingTalkOwner | undefined,
  pairing: DingTalkPairing | undefined,
  message: DingTalkMessage,
  now = Date.now()
): 'pair' | 'queue' | 'ignore' {
  if (!owner) {
    return matchesDingTalkPairing(pairing, message, now) ? 'pair' : 'ignore'
  }
  return sameDingTalkOwner(owner, message.owner) && !/^\/pair(?:\s|$)/i.test(message.text.trim())
    ? 'queue'
    : 'ignore'
}
