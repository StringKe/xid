// 出站 SCIM 下游 bearer token:组织管理员经 API 写入,只以 KEK 信封加密密文存 D1,
// 响应只回 hasToken,明文只在 queue consumer 内解密使用(04 章 3)。
// 存量 target 的 token 在 Workers Secret 里,密文列为空时回退读取。secret 名只由 target id 派生,
// 租户可控的 D1 值绝不能选 Worker binding,否则可借此读出账号级 secret。

import { base64UrlDecode, base64UrlEncode, envelopeDecrypt, envelopeEncrypt } from '@xid-kit/crypto'
import type { schema } from '@xid-kit/db'
import { AppError } from '../lib/errors'
import { isLoopbackHttpUrl, isPublicHttpsUrl } from '../lib/validate'
import { decodeKek } from '../oidc/shared'

const KEK_VERSION = 1
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const SCIM_TARGET_TOKEN_PREFIX = 'SCIM_TARGET_TOKEN_'

type ScimTargetRecord = typeof schema.scimTargets.$inferSelect
type ScimTargetTokenColumns = Pick<ScimTargetRecord, 'tokenIv' | 'tokenCiphertext' | 'tokenTag'>
type ScimTargetTokenSource = Pick<
  ScimTargetRecord,
  'id' | 'tokenIv' | 'tokenCiphertext' | 'tokenTag'
>

type NormalizeScimTargetBaseUrlOptions = {
  environment?: string
}

function invalidBaseUrl(): never {
  throw new AppError('validation_failed', {
    httpStatus: 422,
    meta: { paramName: 'base_url' },
  })
}

function allowsLoopbackHttp(url: URL, options: NormalizeScimTargetBaseUrlOptions): boolean {
  const environment = options.environment?.toLowerCase()
  return (environment === 'development' || environment === 'test') && isLoopbackHttpUrl(url.href)
}

export async function encryptScimTargetToken(
  env: Env,
  token: string,
): Promise<ScimTargetTokenColumns> {
  const kek = decodeKek(env.KEK)
  try {
    const blob = await envelopeEncrypt(new TextEncoder().encode(token), kek, KEK_VERSION)
    return {
      tokenIv: base64UrlEncode(blob.iv),
      tokenCiphertext: base64UrlEncode(blob.ciphertext),
      tokenTag: base64UrlEncode(blob.tag),
    }
  } finally {
    kek.fill(0)
  }
}

export function scimTargetTokenSecretName(targetId: string): string {
  if (!TARGET_ID_PATTERN.test(targetId)) {
    throw new AppError('server_error')
  }
  return `${SCIM_TARGET_TOKEN_PREFIX}${targetId.replaceAll('-', '_')}`
}

function legacySecretToken(env: Env, targetId: string): string | null {
  const value = (env as unknown as Record<string, unknown>)[scimTargetTokenSecretName(targetId)]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function hasEncryptedToken(target: ScimTargetTokenColumns): boolean {
  return target.tokenIv !== null && target.tokenCiphertext !== null && target.tokenTag !== null
}

export function scimTargetHasToken(env: Env, target: ScimTargetTokenSource): boolean {
  return hasEncryptedToken(target) || legacySecretToken(env, target.id) !== null
}

function missingToken(): never {
  throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'token' } })
}

export function assertScimTargetHasToken(env: Env, target: ScimTargetTokenSource): void {
  if (!scimTargetHasToken(env, target)) missingToken()
}

export async function requireScimTargetToken(
  env: Env,
  target: ScimTargetTokenSource,
): Promise<string> {
  const { tokenIv, tokenCiphertext, tokenTag } = target
  if (tokenIv === null || tokenCiphertext === null || tokenTag === null) {
    return legacySecretToken(env, target.id) ?? missingToken()
  }
  const kek = decodeKek(env.KEK)
  try {
    const plaintext = await envelopeDecrypt(
      {
        iv: base64UrlDecode(tokenIv),
        ciphertext: base64UrlDecode(tokenCiphertext),
        tag: base64UrlDecode(tokenTag),
        kekVersion: KEK_VERSION,
      },
      kek,
    )
    return new TextDecoder().decode(plaintext)
  } finally {
    kek.fill(0)
  }
}

export function normalizeScimTargetBaseUrl(
  value: string,
  options: NormalizeScimTargetBaseUrlOptions = {},
): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalidBaseUrl()
  }

  if (!isPublicHttpsUrl(value) && !allowsLoopbackHttp(url, options)) invalidBaseUrl()
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    invalidBaseUrl()
  }
  return url.toString().replace(/\/+$/u, '')
}
