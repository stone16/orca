import { describe, expect, it } from 'vitest'
import { parseDingTalkMessage } from './dingtalk-message'
import { routeDingTalkMessage } from './dingtalk-pairing'

const ownerPayload = {
  chatbotCorpId: 'org-owner',
  senderCorpId: 'org-owner',
  senderStaffId: 'owner',
  conversationId: 'owner-dm',
  conversationType: '1',
  robotCode: 'app-key',
  msgId: 'ding-delivery',
  createAt: 2_000,
  msgtype: 'text',
  text: { content: '/pair 001122AABBCC' }
}

const parse = (fields: Partial<typeof ownerPayload> = {}) =>
  parseDingTalkMessage(JSON.stringify({ ...ownerPayload, ...fields }), 'app-key')

describe('DingTalk owner admission', () => {
  it('pairs only a fresh DM for this app and accepts later text only from the paired owner DM', () => {
    const pairing = { code: '001122AABBCC', issuedAt: 1_500, expiresAt: 301_500 }
    const message = parse()!
    expect(parse({ conversationType: '2' })).toBeNull()
    expect(parse({ robotCode: 'other-app' })).toBeNull()
    expect(parse({ senderCorpId: 'other-org' })).toBeNull()
    expect(routeDingTalkMessage(undefined, pairing, message, 2_001)).toBe('pair')
    expect(routeDingTalkMessage(undefined, pairing, message, 301_500)).toBe('ignore')
    expect(routeDingTalkMessage(undefined, pairing, parse({ createAt: 1_499 })!, 2_001)).toBe(
      'ignore'
    )
    const text = { content: 'Owner follow-up' }
    expect(routeDingTalkMessage(message.owner, undefined, parse({ text })!)).toBe('queue')
    expect(
      routeDingTalkMessage(message.owner, undefined, parse({ text, senderStaffId: 'member' })!)
    ).toBe('ignore')
    expect(
      routeDingTalkMessage(message.owner, undefined, parse({ text, conversationId: 'other-dm' })!)
    ).toBe('ignore')
    expect(routeDingTalkMessage(message.owner, undefined, message)).toBe('ignore')
  })
})
