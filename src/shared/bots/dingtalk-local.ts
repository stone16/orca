export type BotDingTalkStatus = {
  link: 'unconfigured' | 'another-bot' | 'unpaired' | 'paired' | 'unavailable'
  online: boolean
  connectionProblem: 'credentials' | 'network' | null
  sealing: 'os-keychain' | 'host-key' | 'none'
  replyNeedsReview: boolean
}

export type BotDingTalkPairing = { code: string; expiresAt: number }
