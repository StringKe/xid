// 企业 OIDC 连接的 client_secret:KEK 信封加密后存 sso_connections.oidc_client_secret_ciphertext,
// 读接口只暴露是否已配置。格式:kekVersion(1) || iv(12) || ciphertext || tag(16)。

import { envelopeDecrypt, envelopeEncrypt } from '@xid-kit/crypto'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { decodeKek } from '../oidc/shared'

const KEK_VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_SECRET_LENGTH = 1024

// 只写字段:省略 = 保留原值,null = 清除(回到 PKCE public client),字符串 = 设置或轮换。
export const oidcClientSecretInputSchema = v.optional(
  v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SECRET_LENGTH))),
)

export async function oidcClientSecretPatch(
  env: Env,
  value: string | null | undefined,
): Promise<{ oidcClientSecretCiphertext?: Buffer | null }> {
  if (value === undefined) return {}
  if (value === null) return { oidcClientSecretCiphertext: null }
  return { oidcClientSecretCiphertext: await encryptOidcClientSecret(env, value) }
}

export function oidcClientSecretConfigured(row: {
  oidcClientSecretCiphertext: Uint8Array | null
}): boolean {
  return row.oidcClientSecretCiphertext !== null && row.oidcClientSecretCiphertext.byteLength > 0
}

export async function encryptOidcClientSecret(env: Env, secret: string): Promise<Buffer> {
  const blob = await envelopeEncrypt(
    new TextEncoder().encode(secret),
    decodeKek(env.KEK),
    KEK_VERSION,
  )
  const out = new Uint8Array(1 + blob.iv.byteLength + blob.ciphertext.byteLength + TAG_BYTES)
  out[0] = blob.kekVersion & 0xff
  out.set(blob.iv, 1)
  out.set(blob.ciphertext, 1 + blob.iv.byteLength)
  out.set(blob.tag, 1 + blob.iv.byteLength + blob.ciphertext.byteLength)
  return Buffer.from(out)
}

export async function decryptOidcClientSecret(env: Env, stored: Uint8Array): Promise<string> {
  if (stored.byteLength <= 1 + IV_BYTES + TAG_BYTES) throw new AppError('server_error')
  const kekVersion = stored[0] ?? 0
  const iv = stored.slice(1, 1 + IV_BYTES)
  const ciphertext = stored.slice(1 + IV_BYTES, stored.byteLength - TAG_BYTES)
  const tag = stored.slice(stored.byteLength - TAG_BYTES)
  try {
    const plaintext = await envelopeDecrypt({ iv, ciphertext, tag, kekVersion }, decodeKek(env.KEK))
    const secret = new TextDecoder().decode(plaintext)
    plaintext.fill(0)
    return secret
  } catch (cause) {
    throw new AppError('server_error', { cause })
  }
}
