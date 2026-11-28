import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type {
  BotDingTalkPairing,
  BotDingTalkStatus
} from '../../../../../shared/bots/dingtalk-local'
import { useDingTalkStatus } from './use-dingtalk-status'

export function BotDingTalkSetup({
  bot,
  onOpenChange
}: {
  bot: BotRef
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslate()
  const status = useDingTalkStatus(bot)
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('bots.dingtalk.title', 'DingTalk')}</DialogTitle>
          <DialogDescription>
            {t(
              'bots.dingtalk.description',
              'Pair your DingTalk account to chat with this bot in a direct message.'
            )}
          </DialogDescription>
        </DialogHeader>
        <BotDingTalkSettings bot={bot} status={status} />
      </DialogContent>
    </Dialog>
  )
}

export function BotDingTalkSettings({
  bot,
  status
}: {
  bot: BotRef
  status: BotDingTalkStatus | null
}) {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [pair, setPair] = useState<BotDingTalkPairing>()
  const [initial, setInitial] = useState<BotDingTalkStatus>()
  const view = status ?? initial

  useEffect(() => {
    if (!pair) {
      return
    }
    const expires = setTimeout(() => setPair(undefined), Math.max(0, pair.expiresAt - Date.now()))
    return () => clearTimeout(expires)
  }, [pair])

  const request = (run: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setFailed(false)
    return run()
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }

  const configure = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    form.reset()
    const clientId = data.get('clientId')
    const clientSecret = data.get('clientSecret')
    void request(async () =>
      setInitial(
        await callBotRpc<BotDingTalkStatus>(bot, 'bots.dingtalk.configure', {
          botId: bot.id,
          clientId,
          clientSecret
        })
      )
    )
  }
  const createCode = () =>
    void request(async () =>
      setPair(await callBotRpc<BotDingTalkPairing>(bot, 'bots.dingtalk.pair', { botId: bot.id }))
    )
  const disconnect = () =>
    void request(async () => {
      const confirmed = await confirm({
        title: t('bots.dingtalk.disconnectTitle', 'Disconnect DingTalk?'),
        description: t(
          'bots.dingtalk.disconnectDetails',
          'Orca removes the app credentials and pairing from this host. Pending DingTalk deliveries are discarded.'
        ),
        confirmLabel: t('bots.dingtalk.disconnect', 'Disconnect'),
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }
      setPair(undefined)
      setInitial(
        await callBotRpc<BotDingTalkStatus>(bot, 'bots.dingtalk.disconnect', { botId: bot.id })
      )
    })

  let content: ReactNode
  if (!view) {
    content = (
      <p role="status" className="text-sm text-muted-foreground">
        {t('bots.dingtalk.checking', 'Checking connection…')}
      </p>
    )
  } else if (view.link === 'unconfigured') {
    content = (
      <form onSubmit={configure} className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t(
            'bots.dingtalk.createApp',
            'Create a DingTalk internal app with a Stream-mode robot. Use a separate app if another client already uses your robot.'
          )}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="dingtalk-client-id">{t('bots.dingtalk.appKey', 'App Key')}</Label>
          <Input
            id="dingtalk-client-id"
            name="clientId"
            type="password"
            required
            maxLength={256}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dingtalk-client-secret">
            {t('bots.dingtalk.appSecret', 'App Secret')}
          </Label>
          <Input
            id="dingtalk-client-secret"
            name="clientSecret"
            type="password"
            required
            maxLength={512}
            autoComplete="off"
          />
        </div>
        <Button size="sm" type="submit" disabled={busy || view.sealing === 'none'}>
          {t('bots.dingtalk.connect', 'Connect')}
        </Button>
      </form>
    )
  } else if (view.link === 'another-bot') {
    content = (
      <p className="text-sm">
        {t(
          'bots.dingtalk.anotherBot',
          'DingTalk is already connected to another bot on this host.'
        )}
      </p>
    )
  } else {
    content = (
      <div className="space-y-3">
        <p role="status" className="text-sm text-muted-foreground">
          {view.link === 'unavailable'
            ? t('bots.dingtalk.unavailable', 'DingTalk could not open its saved connection.')
            : view.online
              ? t('bots.dingtalk.online', 'Stream connected')
              : view.connectionProblem === 'credentials'
                ? t(
                    'bots.dingtalk.connectionRefused',
                    'DingTalk refused the connection. Check the app credentials and IP allowlist.'
                  )
                : t('bots.dingtalk.offline', 'Waiting for the DingTalk Stream connection…')}
        </p>
        {view.link === 'unpaired' && pair ? (
          <div className="space-y-1.5">
            <p className="text-sm">
              {t(
                'bots.dingtalk.sendCode',
                'Send this command to the robot in a private DingTalk chat within five minutes.'
              )}
            </p>
            <code className="block rounded-md bg-muted px-2 py-1 font-mono text-sm select-text">
              {`/pair ${pair.code}`}
            </code>
          </div>
        ) : null}
        {view.link === 'paired' ? (
          <p className="text-sm">
            {t('bots.dingtalk.paired', 'Paired to your DingTalk direct chat.')}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {view.link === 'unpaired' ? (
            <Button size="sm" onClick={createCode} disabled={busy}>
              {t('bots.dingtalk.createCode', 'Generate pairing code')}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>
            {t('bots.dingtalk.disconnect', 'Disconnect')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {content}
      {view?.sealing === 'none' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('bots.dingtalk.noSealing', 'Secure storage is unavailable on this host.')}
        </p>
      ) : null}
      {view?.sealing === 'host-key' ? (
        <p className="text-sm text-muted-foreground">
          {t(
            'bots.dingtalk.hostKey',
            'This host protects app credentials with its local encryption key.'
          )}
        </p>
      ) : null}
      {view?.replyNeedsReview ? (
        <p role="status" className="text-sm text-status-warning">
          {t(
            'bots.dingtalk.replyUncertain',
            'A DingTalk reply could not be confirmed. Check the chat before resending.'
          )}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('bots.dingtalk.failed', 'The DingTalk change could not be saved. Try again.')}
        </p>
      ) : null}
    </div>
  )
}
