// WebAuthn assertion 测试向量(见 webauthn rule 四验证:challenge/origin/rpIdHash/signature)。
// 合法 assertion + origin 篡改 + rpIdHash 篡改 + 低 sign_count 克隆检测向量。
// 用 Web Crypto 真算合法值;篡改向量在合法向量基础上单点变异。
// 向量文件本身可独立自检。

import type { StoredCredential, WebAuthnVerificationInput } from '@xid-kit/types'

// sign_count 克隆检测从生产模块 import,避免 fixtures 与生产逻辑漂移。
import { detectSignCountAnomaly } from '../../verify-authentication'

// base64url 编解码工具
function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// clientDataJSON 构造(见 01 章 clientDataJSON:type/challenge/origin/crossOrigin)。
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

// authenticatorData 构造(见 01 章 authData 布局:rpIdHash[32] + flags[1] + signCount[4])。
// flags: bit0=UP(user presence) bit2=UV(user verification) bit3=BE bit4=BS bit6=AT
async function buildAuthenticatorData(params: {
  rpId: string
  userVerified: boolean
  signCount: number
  // AT flag(注册时携带 attestedCredentialData),认证时通常 false
  attestedCredentialData?: boolean
}): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(params.rpId)),
  )

  // flags 字节:UP=1 始终设置;UV 按参数
  let flags = 0x01 // UP
  if (params.userVerified) flags |= 0x04 // UV
  if (params.attestedCredentialData) flags |= 0x40 // AT

  const authData = new Uint8Array(37)
  authData.set(rpIdHash, 0)
  authData[32] = flags
  // signCount big-endian 4 bytes
  const view = new DataView(authData.buffer)
  view.setUint32(33, params.signCount, false)

  return authData
}

// 生成 P-256 EC 密钥对(供 assertion 签名)。
export async function generateAssertionKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
}

// 导出 CryptoKey 为 COSE 格式字节(简化:直接输出 raw public key,测试中作 StoredCredential.publicKey)。
export async function exportPublicKeyBytes(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = (await crypto.subtle.exportKey('raw', publicKey)) as ArrayBuffer
  return new Uint8Array(raw)
}

// assertion 签名 = ECDSA(authData || SHA-256(clientDataJSON))。
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

// 合法 assertion 向量。
export type ValidAssertionVector = {
  description: string
  input: WebAuthnVerificationInput
  storedCredential: StoredCredential
}

// 构建合法 assertion 向量。
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
    coseAlg: -7, // ES256
    signCount: 0, // 历史签名计数(上次记录值)
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

// Origin 篡改向量:clientDataJSON 中 origin 与 expectedOrigins 不匹配。
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
  // clientDataJSON 使用篡改 origin
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
      expectedOrigins: [legitimateOrigin], // 合法 origin
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

// rpIdHash 篡改向量:authenticatorData 中 rpIdHash 与 expectedRpId 不匹配。
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
  // authenticatorData 使用篡改 rpId 计算 rpIdHash
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
      expectedRpId: legitimateRpId, // 期望合法 rpId
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

// sign_count 克隆检测向量(见 webauthn rule:新值 <= 历史非零值 -> 标记异常)。
export type SignCountCloneVector = {
  description: string
  newSignCount: number
  storedSignCount: number
  // true = 应标记 signCountAnomaly(不直接拒绝,触发风险审查)
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
