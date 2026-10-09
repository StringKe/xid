// attestation 策略:packed / fido-u2f 签名、x5c 逐级验签到配置的根、有效期、basicConstraints、
// AAGUID 扩展一致性;indirect 无根时 verified=false;direct 拒绝 fmt=none 与不可校验格式。

import { describe, expect, it } from 'vitest'

import { verifyEnterpriseAttestation, type AttestationConveyance } from '../attestation'
import type { CborMap } from '../cbor'
import {
  NOW,
  buildRegistration,
  concat,
  issue,
  pemOf,
  signEs256,
  statement,
  type Issued,
  type Registration,
} from './fixtures/attestation-chain'

const AAGUID = new Uint8Array(16).fill(0x2a)

type Pki = { root: Issued; intermediate: Issued; leaf: Issued }

async function buildPki(options: { leafNotAfter?: Date; intermediateIsCa?: boolean } = {}) {
  const root = await issue({ subject: 'XID Test Root', ca: true })
  const intermediate = await issue({
    subject: 'XID Test Intermediate',
    issuer: root,
    ca: options.intermediateIsCa ?? true,
    pathLen: 0,
  })
  const leaf = await issue({
    subject: 'XID Test Authenticator',
    issuer: intermediate,
    ca: false,
    aaguid: AAGUID,
    ...(options.leafNotAfter ? { notAfter: options.leafNotAfter } : {}),
  })
  return { root, intermediate, leaf } satisfies Pki
}

async function packedStatement(
  registration: Registration,
  x5c: readonly Issued[],
  signer: CryptoKey = x5c[0]!.keys.privateKey,
): Promise<CborMap> {
  const sig = await signEs256(signer, concat(registration.authData, registration.clientDataHash))
  return statement({ alg: -7, sig, x5c: x5c.map((cert) => cert.der) })
}

function verify(
  registration: Registration,
  input: { fmt: string; attStmt: CborMap; policy: AttestationConveyance; roots?: string[] },
) {
  return verifyEnterpriseAttestation({
    fmt: input.fmt,
    attStmt: input.attStmt,
    authData: registration.authData,
    clientDataJson: registration.clientDataJson,
    policy: input.policy,
    trustedRootsPem: input.roots ?? [],
    now: NOW,
  })
}

describe('verifyEnterpriseAttestation: packed with x5c', () => {
  it('verifies a chain that reaches the configured root through an intermediate', async () => {
    const pki = await buildPki()
    const registration = await buildRegistration(AAGUID)
    const attStmt = await packedStatement(registration, [pki.leaf, pki.intermediate])

    const result = await verify(registration, {
      fmt: 'packed',
      attStmt,
      policy: 'direct',
      roots: [pemOf(pki.root)],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.verified).toBe(true)
      expect(result.value.trustPath).toHaveLength(3)
    }
  })

  it('does not trust a public root copied into x5c when it is not the configured root', async () => {
    const pki = await buildPki()
    const other = await buildPki()
    const registration = await buildRegistration(AAGUID)
    const attStmt = await packedStatement(registration, [pki.leaf, pki.intermediate, other.root])

    const direct = await verify(registration, {
      fmt: 'packed',
      attStmt,
      policy: 'direct',
      roots: [pemOf(other.root)],
    })
    const indirect = await verify(registration, {
      fmt: 'packed',
      attStmt,
      policy: 'indirect',
      roots: [pemOf(other.root)],
    })

    expect(direct.ok).toBe(false)
    expect(indirect.ok).toBe(true)
    if (indirect.ok) expect(indirect.value.verified).toBe(false)
  })

  it('reports verified=false under indirect when no root is configured', async () => {
    const pki = await buildPki()
    const registration = await buildRegistration(AAGUID)
    const attStmt = await packedStatement(registration, [pki.leaf, pki.intermediate])

    const result = await verify(registration, { fmt: 'packed', attStmt, policy: 'indirect' })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.verified).toBe(false)
  })

  it('rejects a statement signed by a key other than the leaf certificate', async () => {
    const pki = await buildPki()
    const registration = await buildRegistration(AAGUID)
    const attStmt = await packedStatement(
      registration,
      [pki.leaf, pki.intermediate],
      pki.intermediate.keys.privateKey,
    )

    const result = await verify(registration, {
      fmt: 'packed',
      attStmt,
      policy: 'indirect',
      roots: [pemOf(pki.root)],
    })

    expect(result.ok).toBe(false)
  })

  it('rejects an AAGUID extension that differs from authenticator data', async () => {
    const pki = await buildPki()
    const registration = await buildRegistration(new Uint8Array(16).fill(0x01))
    const attStmt = await packedStatement(registration, [pki.leaf, pki.intermediate])

    const result = await verify(registration, {
      fmt: 'packed',
      attStmt,
      policy: 'indirect',
      roots: [pemOf(pki.root)],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.longMessage).toContain('aaguid')
  })

  it('rejects an expired leaf certificate under direct', async () => {
    const pki = await buildPki({ leafNotAfter: new Date('2026-03-01T00:00:00Z') })
    const registration = await buildRegistration(AAGUID)
    const attStmt = await packedStatement(registration, [pki.leaf, pki.intermediate])

    const result = await verify(registration, {
      fmt: 'packed',
      attStmt,
      policy: 'direct',
      roots: [pemOf(pki.root)],
    })

    expect(result.ok).toBe(false)
  })

  it('rejects a chain whose intermediate is not a CA under direct', async () => {
    const pki = await buildPki({ intermediateIsCa: false })
    const registration = await buildRegistration(AAGUID)
    const attStmt = await packedStatement(registration, [pki.leaf, pki.intermediate])

    const result = await verify(registration, {
      fmt: 'packed',
      attStmt,
      policy: 'direct',
      roots: [pemOf(pki.root)],
    })

    expect(result.ok).toBe(false)
  })

  it('verifies a chain whose root uses RSA', async () => {
    const root = await issue({ subject: 'XID RSA Root', ca: true, rsa: true })
    const leaf = await issue({ subject: 'XID Authenticator', issuer: root, ca: false })
    const registration = await buildRegistration(AAGUID)
    const attStmt = await packedStatement(registration, [leaf])

    const result = await verify(registration, {
      fmt: 'packed',
      attStmt,
      policy: 'direct',
      roots: [pemOf(root)],
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.verified).toBe(true)
  })
})

describe('verifyEnterpriseAttestation: packed self attestation', () => {
  it('accepts a valid self signature under indirect without marking it verified', async () => {
    const registration = await buildRegistration(AAGUID)
    const sig = await signEs256(
      registration.credentialKeys.privateKey,
      concat(registration.authData, registration.clientDataHash),
    )

    const result = await verify(registration, {
      fmt: 'packed',
      attStmt: statement({ alg: -7, sig }),
      policy: 'indirect',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.verified).toBe(false)
  })

  it('rejects an invalid self signature under indirect', async () => {
    const registration = await buildRegistration(AAGUID)

    const result = await verify(registration, {
      fmt: 'packed',
      attStmt: statement({ alg: -7, sig: new Uint8Array([0x30, 0x00]) }),
      policy: 'indirect',
    })

    expect(result.ok).toBe(false)
  })
})

describe('verifyEnterpriseAttestation: fido-u2f', () => {
  async function u2fStatement(registration: Registration, leaf: Issued): Promise<CborMap> {
    const signed = concat(
      new Uint8Array([0x00]),
      registration.rpIdHash,
      registration.clientDataHash,
      registration.credentialId,
      registration.rawPublicKey,
    )
    return statement({ sig: await signEs256(leaf.keys.privateKey, signed), x5c: [leaf.der] })
  }

  it('verifies a U2F attestation that chains to the configured root', async () => {
    const root = await issue({ subject: 'XID U2F Root', ca: true })
    const leaf = await issue({ subject: 'XID U2F Key', issuer: root, ca: false })
    const registration = await buildRegistration(new Uint8Array(16))

    const result = await verify(registration, {
      fmt: 'fido-u2f',
      attStmt: await u2fStatement(registration, leaf),
      policy: 'direct',
      roots: [pemOf(root)],
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.verified).toBe(true)
  })

  it('rejects a U2F signature over different data', async () => {
    const root = await issue({ subject: 'XID U2F Root', ca: true })
    const leaf = await issue({ subject: 'XID U2F Key', issuer: root, ca: false })
    const registration = await buildRegistration(new Uint8Array(16))
    const other = await buildRegistration(new Uint8Array(16))

    const result = await verify(registration, {
      fmt: 'fido-u2f',
      attStmt: await u2fStatement(other, leaf),
      policy: 'indirect',
      roots: [pemOf(root)],
    })

    expect(result.ok).toBe(false)
  })
})

describe('verifyEnterpriseAttestation: policy', () => {
  it('rejects fmt=none under direct', async () => {
    const registration = await buildRegistration(AAGUID)

    const result = await verify(registration, {
      fmt: 'none',
      attStmt: statement({}),
      policy: 'direct',
      roots: [pemOf(await issue({ subject: 'Root', ca: true }))],
    })

    expect(result.ok).toBe(false)
  })

  it('rejects direct when trusted roots are not configured', async () => {
    const registration = await buildRegistration(AAGUID)

    const result = await verify(registration, {
      fmt: 'packed',
      attStmt: statement({ alg: -7, sig: new Uint8Array(0) }),
      policy: 'direct',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.longMessage).toContain('trusted attestation roots')
  })

  it.each(['tpm', 'android-key', 'apple'])(
    'treats unsupported fmt %s as none under indirect and rejects it under direct',
    async (fmt) => {
      const registration = await buildRegistration(AAGUID)
      const roots = [pemOf(await issue({ subject: 'Root', ca: true }))]

      const indirect = await verify(registration, {
        fmt,
        attStmt: statement({}),
        policy: 'indirect',
        roots,
      })
      const direct = await verify(registration, {
        fmt,
        attStmt: statement({}),
        policy: 'direct',
        roots,
      })

      expect(indirect.ok).toBe(true)
      if (indirect.ok) expect(indirect.value.verified).toBe(false)
      expect(direct.ok).toBe(false)
    },
  )

  it('accepts anything under none without verification', async () => {
    const registration = await buildRegistration(AAGUID)

    const result = await verify(registration, {
      fmt: 'none',
      attStmt: statement({}),
      policy: 'none',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.verified).toBe(false)
  })
})
