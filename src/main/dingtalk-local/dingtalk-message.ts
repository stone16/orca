import { createHash } from 'node:crypto'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'

export const DINGTALK_BOT_TOPIC = '/v1.0/im/bot/messages/get'
const identifier = () => z.string().min(1).max(512)

const StreamFrame = lazyZodSchema(() =>
  z.object({
    specVersion: z.literal('1.0'),
    type: z.enum(['SYSTEM', 'CALLBACK']),
    headers: z.object({ topic: identifier(), messageId: identifier() }).passthrough(),
    data: z.string()
  })
)

export const DingTalkOwner = lazyZodSchema(() =>
  z.object({ staffId: identifier(), corpId: identifier(), conversationId: identifier() })
)
export type DingTalkOwner = z.infer<typeof DingTalkOwner>

const InboundText = lazyZodSchema(() =>
  z.object({
    conversationType: z.literal('1'),
    chatbotCorpId: identifier(),
    senderCorpId: identifier(),
    senderStaffId: identifier(),
    conversationId: identifier(),
    robotCode: identifier(),
    msgId: identifier(),
    createAt: z.number().int().positive(),
    msgtype: z.literal('text'),
    text: z.object({ content: z.string().min(1).max(16_384) })
  })
)

export type DingTalkMessage = {
  owner: DingTalkOwner
  deliveryId: string
  createdAt: number
  text: string
}

function decode(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function parseDingTalkFrame(text: string): z.infer<typeof StreamFrame> | undefined {
  const parsed = StreamFrame.safeParse(decode(text))
  return parsed.success ? parsed.data : undefined
}

export function parseDingTalkMessage(data: string, clientId: string): DingTalkMessage | null {
  const parsed = InboundText.safeParse(decode(data))
  if (!parsed.success) {
    return null
  }
  const value = parsed.data
  if (
    value.robotCode !== clientId ||
    value.senderCorpId !== value.chatbotCorpId ||
    !value.text.content.trim()
  ) {
    return null
  }
  return {
    owner: {
      staffId: value.senderStaffId,
      corpId: value.senderCorpId,
      conversationId: value.conversationId
    },
    deliveryId: `dingtalk-${createHash('sha256').update(value.msgId).digest('base64url')}`,
    createdAt: value.createAt,
    text: value.text.content
  }
}

export function dingTalkAck(headers: Record<string, unknown>, data: string): string {
  return JSON.stringify({ code: 200, headers, message: 'OK', data })
}

export function sameDingTalkOwner(a: DingTalkOwner, b: DingTalkOwner): boolean {
  return a.staffId === b.staffId && a.corpId === b.corpId && a.conversationId === b.conversationId
}
