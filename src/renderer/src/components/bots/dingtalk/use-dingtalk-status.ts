import { useEffect, useState } from 'react'
import { BOTS_CHANGED_EVENT } from '@/lib/bots-changed-window-event'
import { useBotHostHas } from '@/lib/bot-host-status'
import { botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { BOTS_DINGTALK_RUNTIME_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { BotDingTalkStatus } from '../../../../../shared/bots/dingtalk-local'

export function useDingTalkStatus(bot: BotRef | null): BotDingTalkStatus | null {
  const hostId = bot?.hostId ?? LOCAL_EXECUTION_HOST_ID
  const id = bot?.id
  const supported = useBotHostHas(hostId, BOTS_DINGTALK_RUNTIME_CAPABILITY)
  const key = bot ? botRefKey(bot) : null
  const [seen, setSeen] = useState<{ key: string; state: BotDingTalkStatus }>()
  useEffect(() => {
    if (!id || !key || !supported) {
      return
    }
    let sequence = 0
    let active = true
    const refresh = () => {
      const update = ++sequence
      void callBotRpc<BotDingTalkStatus>({ hostId }, 'bots.dingtalk.status', { botId: id })
        .then((state) => {
          if (active && update === sequence) {
            setSeen({ key, state })
          }
        })
        .catch(() => {})
    }
    refresh()
    window.addEventListener(BOTS_CHANGED_EVENT, refresh)
    return () => {
      active = false
      window.removeEventListener(BOTS_CHANGED_EVENT, refresh)
    }
  }, [hostId, id, key, supported])
  return supported && seen?.key === key ? seen.state : null
}
