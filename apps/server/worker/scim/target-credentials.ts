// Outbound SCIM credentials use a server-derived secret name. A tenant-controlled database value
// must never select an arbitrary Worker binding, otherwise it could exfiltrate account-level secrets.

import { AppError } from '../lib/errors'
import { isLoopbackHttpUrl, isPublicHttpsUrl } from '../lib/validate'

const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const SCIM_TARGET_TOKEN_PREFIX = 'SCIM_TARGET_TOKEN_'

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

export function scimTargetTokenSecretName(targetId: string): string {
  if (!TARGET_ID_PATTERN.test(targetId)) {
    throw new AppError('server_error')
  }
  return `${SCIM_TARGET_TOKEN_PREFIX}${targetId.replaceAll('-', '_')}`
}

export function scimTargetHasToken(env: Env, targetId: string): boolean {
  const name = scimTargetTokenSecretName(targetId)
  const value = (env as unknown as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim().length > 0
}

export function requireScimTargetToken(env: Env, targetId: string): string {
  const name = scimTargetTokenSecretName(targetId)
  const value = (env as unknown as Record<string, unknown>)[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'token_secret_ref' },
    })
  }
  return value
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
