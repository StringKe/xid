// assertion 测试向量：合法路径用 Web Crypto 真算，负路径在合法值上单点变异。

import type { StoredCredential, WebAuthnVerificationInput } from '@xid-kit/types'

// 从生产模块 import，避免 fixtures 与克隆检测逻辑漂移。
import { detectSignCountAnomaly } from '../../verify-authentication'

function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function buildClientDataJson(params: {
  type: 'webauthn.get' | 'webauthn.create'
  challenge: Uint8Array
  origin: string
  crossOrigin?: boolean
}): Uint8Array {
  const challengeB64 = base64UrlEncode(params.challenge)
  const obj = {
    type: params.type,
    challenge: challengeB64,
    origin: params.origin,
    crossOrigin: params.crossOrigin ?? false,
  }
  return new TextEncoder().encode(JSON.stringify(obj))
}

async function buildAuthenticatorData(params: {
  rpId: string
  userVerified: boolean
  signCount: number
  attestedCredentialData?: boolean
}): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(params.rpId)),
  )

  let flags = 0x01 // UP
  if (params.userVerified) flags |= 0x04 // UV
  if (params.attestedCredentialData) flags |= 0x40 // AT

  const authData = new Uint8Array(37)
  authData.set(rpIdHash, 0)
  authData[32] = flags
  const view = new DataView(authData.buffer)
  view.setUint32(33, params.signCount, false)

  return authData
}

export async function generateAssertionKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
}

// 测试用简化导出：raw 公钥字节，非完整 COSE map。
export async function exportPublicKeyBytes(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = (await crypto.subtle.exportKey('raw', publicKey)) as ArrayBuffer
  return new Uint8Array(raw)
}

async function buildAssertionSignature(
  authenticatorData: Uint8Array,
  clientDataJson: Uint8Array,
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJson))
  const toSign = new Uint8Array(authenticatorData.length + clientDataHash.length)
  toSign.set(authenticatorData, 0)
  toSign.set(clientDataHash, authenticatorData.length)

  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, toSign)
  return new Uint8Array(sig)
}

export type ValidAssertionVector = {
  description: string
  input: WebAuthnVerificationInput
  storedCredential: StoredCredential
}

export async function buildValidAssertionVector(
  rpId: string,
  origin: string,
  signCount: number = 1,
): Promise<ValidAssertionVector & { keyPair: CryptoKeyPair }> {
  const keyPair = await generateAssertionKeyPair()
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const clientDataJson = buildClientDataJson({ type: 'webauthn.get', challenge, origin })
  const authData = await buildAuthenticatorData({ rpId, userVerified: true, signCount })
  const signature = await buildAssertionSignature(authData, clientDataJson, keyPair.privateKey)
  const publicKeyBytes = await exportPublicKeyBytes(keyPair.publicKey)

  const credentialId = crypto.getRandomValues(new Uint8Array(16))

  const storedCredential: StoredCredential = {
    credentialId,
    publicKey: publicKeyBytes,
    coseAlg: -7,
    signCount: 0,
    aaguid: new Uint8Array(16),
  }

  return {
    description: `valid assertion (rpId=${rpId}, origin=${origin}, signCount=${signCount})`,
    input: {
      ceremony: 'authentication',
      expectedChallenge: challenge,
      expectedRpId: rpId,
      expectedOrigins: [origin],
      clientDataJson,
      authenticatorData: authData,
      signature,
      storedCredential,
    },
    storedCredential,
    keyPair,
  }
}

export type OriginTamperedVector = {
  description: string
  input: WebAuthnVerificationInput
  expectedErrorCode: 'origin_mismatch'
}

export async function buildOriginTamperedVector(
  rpId: string,
  legitimateOrigin: string,
  tamperedOrigin: string,
): Promise<OriginTamperedVector> {
  const keyPair = await generateAssertionKeyPair()
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const clientDataJson = buildClientDataJson({
    type: 'webauthn.get',
    challenge,
    origin: tamperedOrigin,
  })
  const authData = await buildAuthenticatorData({ rpId, userVerified: true, signCount: 1 })
  const signature = await buildAssertionSignature(authData, clientDataJson, keyPair.privateKey)
  const publicKeyBytes = await exportPublicKeyBytes(keyPair.publicKey)
  const credentialId = crypto.getRandomValues(new Uint8Array(16))

  return {
    description: `origin tampered: expected ${legitimateOrigin}, got ${tamperedOrigin}`,
    input: {
      ceremony: 'authentication',
      expectedChallenge: challenge,
      expectedRpId: rpId,
      expectedOrigins: [legitimateOrigin],
      clientDataJson,
      authenticatorData: authData,
      signature,
      storedCredential: {
        credentialId,
        publicKey: publicKeyBytes,
        coseAlg: -7,
        signCount: 0,
        aaguid: new Uint8Array(16),
      },
    },
    expectedErrorCode: 'origin_mismatch',
  }
}

export type RpIdHashTamperedVector = {
  description: string
  input: WebAuthnVerificationInput
  expectedErrorCode: 'rpid_mismatch'
}

export async function buildRpIdHashTamperedVector(
  legitimateRpId: string,
  tamperedRpId: string,
  origin: string,
): Promise<RpIdHashTamperedVector> {
  const keyPair = await generateAssertionKeyPair()
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const clientDataJson = buildClientDataJson({ type: 'webauthn.get', challenge, origin })
  const authData = await buildAuthenticatorData({
    rpId: tamperedRpId,
    userVerified: true,
    signCount: 1,
  })
  const signature = await buildAssertionSignature(authData, clientDataJson, keyPair.privateKey)
  const publicKeyBytes = await exportPublicKeyBytes(keyPair.publicKey)
  const credentialId = crypto.getRandomValues(new Uint8Array(16))

  return {
    description: `rpIdHash tampered: authData contains SHA-256(${tamperedRpId}), expected SHA-256(${legitimateRpId})`,
    input: {
      ceremony: 'authentication',
      expectedChallenge: challenge,
      expectedRpId: legitimateRpId,
      expectedOrigins: [origin],
      clientDataJson,
      authenticatorData: authData,
      signature,
      storedCredential: {
        credentialId,
        publicKey: publicKeyBytes,
        coseAlg: -7,
        signCount: 0,
        aaguid: new Uint8Array(16),
      },
    },
    expectedErrorCode: 'rpid_mismatch',
  }
}

// shouldFlagAnomaly=true 表示应标记异常，不直接拒绝。
export type SignCountCloneVector = {
  description: string
  newSignCount: number
  storedSignCount: number
  shouldFlagAnomaly: boolean
}

export const SIGN_COUNT_CLONE_VECTORS: readonly SignCountCloneVector[] = [
  {
    description: 'clone detection: new count <= stored non-zero count',
    newSignCount: 1,
    storedSignCount: 5,
    shouldFlagAnomaly: true,
  },
  {
    description: 'clone detection: new count equal to stored',
    newSignCount: 3,
    storedSignCount: 3,
    shouldFlagAnomaly: true,
  },
  {
    description: 'normal progression: new count > stored count',
    newSignCount: 6,
    storedSignCount: 5,
    shouldFlagAnomaly: false,
  },
  {
    description: 'both zero (platform sync passkey): no anomaly',
    newSignCount: 0,
    storedSignCount: 0,
    shouldFlagAnomaly: false,
  },
  {
    description: 'new count zero, stored non-zero: anomaly',
    newSignCount: 0,
    storedSignCount: 2,
    shouldFlagAnomaly: true,
  },
]

export { buildClientDataJson, buildAuthenticatorData, detectSignCountAnomaly }
