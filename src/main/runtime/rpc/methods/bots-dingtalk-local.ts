import {
  BotDingTalkConfigure,
  BotDingTalkTarget
} from '../../../../shared/rpc-contract/bots-dingtalk-local-params'
import { DingTalkLocalHost } from '../../../dingtalk-local/dingtalk-local-host'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'

function ownBotHost(context: RpcContext, botId: string): DingTalkLocalHost {
  ownerOnly(context, 'Set up DingTalk from the bot’s Connectors settings in Orca.')
  const { runtime } = context
  runtime.bots.assertEnabled()
  if (!context.caller || context.plugin || !runtime.bots.list().some(({ id }) => id === botId)) {
    throw new InvalidArgumentError('No such bot on this host.')
  }
  const connector = runtime.localConnectors.find(DingTalkLocalHost)
  if (!connector) {
    throw new InvalidArgumentError('DingTalk is unavailable on this host.')
  }
  return connector
}

export const BOT_DINGTALK_LOCAL_METHODS = [
  defineMethod({
    name: 'bots.dingtalk.status',
    permission: 'workspace',
    params: BotDingTalkTarget,
    handler: ({ botId }, context) => ownBotHost(context, botId).status(botId)
  }),
  defineMethod({
    name: 'bots.dingtalk.configure',
    permission: 'accounts-admin',
    params: BotDingTalkConfigure,
    handler: ({ botId, clientId, clientSecret }, context) =>
      ownBotHost(context, botId).configure(botId, { clientId, clientSecret })
  }),
  defineMethod({
    name: 'bots.dingtalk.pair',
    permission: 'accounts-admin',
    params: BotDingTalkTarget,
    handler: ({ botId }, context) => ownBotHost(context, botId).pair(botId)
  }),
  defineMethod({
    name: 'bots.dingtalk.disconnect',
    permission: 'accounts-admin',
    params: BotDingTalkTarget,
    handler: async ({ botId }, context) => {
      const connector = ownBotHost(context, botId)
      await connector.disconnect(botId)
      return connector.status(botId)
    }
  })
] as const
