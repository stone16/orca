import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { getSecretStore, type SecretSealing } from '../../shared/secure-storage/secret-store'

const Credentials = lazyZodSchema(() =>
  z.object({ clientId: z.string().min(1).max(256), clientSecret: z.string().min(1).max(512) })
)
export type DingTalkCredentials = z.infer<typeof Credentials>

export function dingTalkSealing(): SecretSealing {
  return (
    getSecretStore().describeSealing?.() ?? {
      kind: 'none',
      reason: 'Secure storage is unavailable.'
    }
  )
}

export async function sealDingTalkCredentials(credentials: DingTalkCredentials): Promise<string> {
  const store = getSecretStore()
  if (dingTalkSealing().kind === 'none' || !store.isEncryptionAvailable()) {
    throw new Error('dingtalk_secure_storage_unavailable')
  }
  const plain = JSON.stringify(credentials)
  const sealed = store.encryptStringAsync
    ? await store.encryptStringAsync(plain)
    : store.encryptString(plain)
  return sealed.toString('base64')
}

export function unsealDingTalkCredentials(sealed: string): DingTalkCredentials {
  try {
    return Credentials.parse(
      JSON.parse(getSecretStore().decryptString(Buffer.from(sealed, 'base64')))
    )
  } catch {
    throw new Error('dingtalk_credentials_unavailable')
  }
}
