// passkey 注册 ceremony 的浏览器侧工具:base64url 编解码 + navigator.credentials.create 封装。
// 只做格式编解码(crypto-boundary rule:格式编解码自研);四验证在 server 侧,见 webauthn rule。
// 请求/响应形状对照 apps/server/worker/auth/passkey.ts 的 register options/verify handler。

import type { Result, XidError } from '@xid-kit/types'

import { makeXidError } from './errors'

// POST /auth/passkey/register/options 响应体。
export type PasskeyRegistrationOptions = {
  challenge: string
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: PublicKeyCredentialParameters[]
  authenticatorSelection?: AuthenticatorSelectionCriteria
  attestation?: AttestationConveyancePreference
  timeout?: number
  excludeCredentials?: Array<{
    id: string
    type: PublicKeyCredentialType
    transports?: AuthenticatorTransport[]
  }>
}

// POST /auth/passkey/register/verify 请求体。
export type PasskeyRegistrationVerifyBody = {
  id: string
  rawId: string
  response: {
    clientDataJSON: string
    attestationObject: string
  }
  transports?: AuthenticatorTransport[]
  deviceName?: string
}

// base64url -> bytes(challenge / user.id / excludeCredentials.id 解码)。
export function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let idx = 0; idx < binary.length; idx++) bytes[idx] = binary.charCodeAt(idx)
  return bytes
}

// bytes -> base64url(rawId / clientDataJSON / attestationObject 编码)。
export function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replaceAll('=', '')
}

// register/options 响应 -> navigator.credentials.create 入参(base64url 字段转 bytes)。
export function registrationOptionsToPublicKey(
  options: PasskeyRegistrationOptions,
): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: b64urlToBytes(options.challenge),
    user: {
      ...options.user,
      id: b64urlToBytes(options.user.id),
    },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: b64urlToBytes(credential.id),
    })),
  }
}

// 执行注册 ceremony 并把 attestation 序列化为 register/verify 请求体。
// 用户取消认证器提示(NotAllowedError)是预期失败 -> Result,不 throw 裸异常(error-handling rule);
// 其余 DOMException 属意外,继续 throw。
export async function createPasskeyCredential(
  options: PasskeyRegistrationOptions,
  input: { deviceName?: string } = {},
): Promise<Result<PasskeyRegistrationVerifyBody, XidError>> {
  if (
    typeof navigator === 'undefined' ||
    !('credentials' in navigator) ||
    typeof PublicKeyCredential === 'undefined'
  ) {
    return {
      ok: false,
      error: makeXidError('not_implemented', 'This browser does not support passkeys.'),
    }
  }

  let credential: Credential | null
  try {
    credential = await navigator.credentials.create({
      publicKey: registrationOptionsToPublicKey(options),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return { ok: false, error: passkeyCancelledError() }
    }
    throw error
  }
  if (!credential) {
    return { ok: false, error: passkeyCancelledError() }
  }

  const attestation = credential as PublicKeyCredential
  const response = attestation.response as AuthenticatorAttestationResponse
  return {
    ok: true,
    value: {
      id: attestation.id,
      rawId: bytesToB64url(attestation.rawId),
      response: {
        clientDataJSON: bytesToB64url(response.clientDataJSON),
        attestationObject: bytesToB64url(response.attestationObject),
      },
      ...(typeof response.getTransports === 'function'
        ? { transports: response.getTransports() as AuthenticatorTransport[] }
        : {}),
      ...(input.deviceName ? { deviceName: input.deviceName } : {}),
    },
  }
}

function passkeyCancelledError(): XidError {
  return makeXidError('access_denied', 'The passkey registration was cancelled or timed out.')
}
