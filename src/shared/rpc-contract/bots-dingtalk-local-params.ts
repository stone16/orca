import { z } from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

export const BotDingTalkTarget = lazyZodSchema(() =>
  z.object({ botId: z.string().min(1).max(256) })
)

export const BotDingTalkConfigure = lazyZodSchema(() =>
  BotDingTalkTarget.extend({
    clientId: z.string().trim().min(1).max(256),
    clientSecret: z.string().trim().min(1).max(512)
  })
)
