// tpm / android-key / apple attestation(WebAuthn L3 §8.3 / §8.4 / §8.8),以及停用的 android-safetynet。
// 证书与 TPM 结构在测试里现场构造;链都抵达测试根,direct 下 verified=true,篡改任一绑定项即拒绝。

import 'reflect-metadata'
import { AsnConvert } from '@peculiar/asn1-schema'
import {
  AttributeTypeAndValue,
  AttributeValue,
  GeneralName,
  Name,
  RelativeDistinguishedName,
  SubjectAlternativeName,
} from '@peculiar/asn1-x509'
import * as x509 from '@peculiar/x509'
import * as asn1js from 'asn1js'
import { describe, expect, it } from 'vitest'

import { verifyEnterpriseAttestation } from '../attestation'
import type { CborMap } from '../cbor'
import {
  NOW,
  buildRegistration,
  concat,
  generateP256Keys,
  issue,
  pemOf,
  signEs256,
  statement,
  type Issued,
  type Registration,
} from './fixtures/attestation-chain'

const AAGUID = new Uint8Array(16).fill(0x3c)

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff])
}

function sized(bytes: Uint8Array): Uint8Array {
  return concat(u16(bytes.length), bytes)
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

function verify(registration: Registration, fmt: string, attStmt: CborMap, root: Issued) {
  return verifyEnterpriseAttestation({
    fmt,
    attStmt,
    authData: registration.authData,
    clientDataJson: registration.clientDataJson,
    policy: 'direct',
    trustedRootsPem: [pemOf(root)],
    now: NOW,
  })
}

describe('tpm attestation', () => {
  function pubAreaFor(registration: Registration): Uint8Array {
    const x = registration.rawPublicKey.subarray(1, 33)
    const y = registration.rawPublicKey.subarray(33, 65)
    return concat(
      u16(0x0023),
      u16(0x000b),
      new Uint8Array([0x00, 0x06, 0x04, 0x72]),
      sized(new Uint8Array(0)),
      u16(0x0010),
      u16(0x0010),
      u16(0x0003),
      u16(0x0010),
      sized(x),
      sized(y),
    )
  }

  async function certInfoFor(
    registration: Registration,
    pubArea: Uint8Array,
    extraData?: Uint8Array,
  ): Promise<Uint8Array> {
    const name = concat(u16(0x000b), await sha256(pubArea))
    return concat(
      new Uint8Array([0xff, 0x54, 0x43, 0x47]),
      u16(0x8017),
      sized(new Uint8Array(0)),
      sized(
        extraData ?? (await sha256(concat(registration.authData, registration.clientDataHash))),
      ),
      new Uint8Array(17),
      new Uint8Array(8),
      sized(name),
      sized(new Uint8Array(0)),
    )
  }

  function tpmSan(): x509.Extension {
    const manufacturer = new AttributeTypeAndValue({
      type: '2.23.133.2.1',
      value: new AttributeValue({ utf8String: 'id:FFFFF1D0' }),
    })
    const san = new SubjectAlternativeName([
      new GeneralName({
        directoryName: new Name([new RelativeDistinguishedName([manufacturer])]),
      }),
    ])
    return new x509.Extension('2.5.29.17', true, AsnConvert.serialize(san))
  }

  async function tpmFixture(options: { extraData?: Uint8Array; subject?: 'empty' | 'named' } = {}) {
    const root = await issue({ subject: 'TPM Test Root', ca: true })
    const aik = await issue({
      subject: 'AIK',
      issuer: root,
      ca: false,
      emptySubject: options.subject !== 'named',
      aaguid: AAGUID,
      extensions: [tpmSan(), new x509.ExtendedKeyUsageExtension(['2.23.133.8.3'])],
    })
    const registration = await buildRegistration(AAGUID)
    const pubArea = pubAreaFor(registration)
    const certInfo = await certInfoFor(registration, pubArea, options.extraData)
    const attStmt = statement({
      ver: '2.0',
      alg: -7,
      x5c: [aik.der],
      sig: await signEs256(aik.keys.privateKey, certInfo),
      certInfo,
      pubArea,
    })
    return { root, registration, attStmt }
  }

  it('verifies a TPM attestation whose AIK chains to the configured root', async () => {
    const { root, registration, attStmt } = await tpmFixture()

    const result = await verify(registration, 'tpm', attStmt, root)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.verified).toBe(true)
  })

  it('rejects certInfo whose extraData does not bind this registration', async () => {
    const { root, registration, attStmt } = await tpmFixture({ extraData: new Uint8Array(32) })

    const result = await verify(registration, 'tpm', attStmt, root)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.longMessage).toContain('extraData')
  })

  it('rejects a pubArea that differs from the credential public key', async () => {
    const { root, attStmt } = await tpmFixture()
    const other = await buildRegistration(AAGUID)

    const result = await verify(other, 'tpm', attStmt, root)

    expect(result.ok).toBe(false)
  })

  it('rejects an AIK certificate with a non-empty subject', async () => {
    const { root, registration, attStmt } = await tpmFixture({ subject: 'named' })

    const result = await verify(registration, 'tpm', attStmt, root)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.longMessage).toContain('subject')
  })
})

describe('android-key attestation', () => {
  function keyDescription(challenge: Uint8Array, tee: asn1js.BaseBlock[]): x509.Extension {
    const description = new asn1js.Sequence({
      value: [
        new asn1js.Integer({ value: 200 }),
        new asn1js.Enumerated({ value: 1 }),
        new asn1js.Integer({ value: 200 }),
        new asn1js.Enumerated({ value: 1 }),
        new asn1js.OctetString({ valueHex: challenge }),
        new asn1js.OctetString({ valueHex: new Uint8Array(0) }),
        new asn1js.Sequence({ value: [] }),
        new asn1js.Sequence({ value: tee }),
      ],
    })
    return new x509.Extension('1.3.6.1.4.1.11129.2.1.17', false, description.toBER())
  }

  function tagged(tag: number, inner: asn1js.BaseBlock): asn1js.Constructed {
    return new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: tag }, value: [inner] })
  }

  const GENERATED_SIGNING_KEY = [
    tagged(1, new asn1js.Set({ value: [new asn1js.Integer({ value: 2 })] })),
    tagged(702, new asn1js.Integer({ value: 0 })),
  ]

  async function androidFixture(
    options: { challenge?: Uint8Array; tee?: asn1js.BaseBlock[] } = {},
  ) {
    const root = await issue({ subject: 'Android Test Root', ca: true })
    const credentialKeys = await generateP256Keys()
    const registration = await buildRegistration(AAGUID, credentialKeys)
    const leaf = await issue({
      subject: 'Android Keystore Key',
      issuer: root,
      ca: false,
      keys: credentialKeys,
      extensions: [
        keyDescription(
          options.challenge ?? registration.clientDataHash,
          options.tee ?? GENERATED_SIGNING_KEY,
        ),
      ],
    })
    const sig = await signEs256(
      credentialKeys.privateKey,
      concat(registration.authData, registration.clientDataHash),
    )
    return { root, registration, attStmt: statement({ alg: -7, sig, x5c: [leaf.der] }) }
  }

  it('verifies an Android keystore attestation bound to this registration', async () => {
    const { root, registration, attStmt } = await androidFixture()

    const result = await verify(registration, 'android-key', attStmt, root)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.verified).toBe(true)
  })

  it('rejects an attestation challenge from another ceremony', async () => {
    const { root, registration, attStmt } = await androidFixture({
      challenge: new Uint8Array(32).fill(7),
    })

    const result = await verify(registration, 'android-key', attStmt, root)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.longMessage).toContain('challenge')
  })

  it('rejects a key bound to all applications', async () => {
    const { root, registration, attStmt } = await androidFixture({
      tee: [...GENERATED_SIGNING_KEY, tagged(600, new asn1js.Null())],
    })

    const result = await verify(registration, 'android-key', attStmt, root)

    expect(result.ok).toBe(false)
  })

  it('rejects an imported key', async () => {
    const { root, registration, attStmt } = await androidFixture({
      tee: [GENERATED_SIGNING_KEY[0]!, tagged(702, new asn1js.Integer({ value: 2 }))],
    })

    const result = await verify(registration, 'android-key', attStmt, root)

    expect(result.ok).toBe(false)
  })
})

describe('apple attestation', () => {
  function nonceExtension(nonce: Uint8Array): x509.Extension {
    const value = new asn1js.Sequence({
      value: [
        new asn1js.Constructed({
          idBlock: { tagClass: 3, tagNumber: 1 },
          value: [new asn1js.OctetString({ valueHex: nonce })],
        }),
      ],
    })
    return new x509.Extension('1.2.840.113635.100.8.2', false, value.toBER())
  }

  async function appleFixture(options: { nonce?: Uint8Array; otherKey?: boolean } = {}) {
    const root = await issue({ subject: 'Apple Test Root', ca: true })
    const credentialKeys = await generateP256Keys()
    const registration = await buildRegistration(AAGUID, credentialKeys)
    const nonce =
      options.nonce ?? (await sha256(concat(registration.authData, registration.clientDataHash)))
    const credCert = await issue({
      subject: 'Apple Credential',
      issuer: root,
      ca: false,
      keys: options.otherKey ? await generateP256Keys() : credentialKeys,
      extensions: [nonceExtension(nonce)],
    })
    return { root, registration, attStmt: statement({ x5c: [credCert.der] }) }
  }

  it('verifies an Apple attestation whose nonce binds this registration', async () => {
    const { root, registration, attStmt } = await appleFixture()

    const result = await verify(registration, 'apple', attStmt, root)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.verified).toBe(true)
  })

  it('rejects a nonce computed for another registration', async () => {
    const { root, registration, attStmt } = await appleFixture({ nonce: new Uint8Array(32) })

    const result = await verify(registration, 'apple', attStmt, root)

    expect(result.ok).toBe(false)
  })

  it('rejects a credential certificate holding a different key', async () => {
    const { root, registration, attStmt } = await appleFixture({ otherKey: true })

    const result = await verify(registration, 'apple', attStmt, root)

    expect(result.ok).toBe(false)
  })
})

describe('android-safetynet attestation', () => {
  it.each(['indirect', 'direct'] as const)('is rejected under %s', async (policy) => {
    const registration = await buildRegistration(AAGUID)
    const root = await issue({ subject: 'Root', ca: true })

    const result = await verifyEnterpriseAttestation({
      fmt: 'android-safetynet',
      attStmt: statement({ ver: '1', response: new Uint8Array(1) }),
      authData: registration.authData,
      clientDataJson: registration.clientDataJson,
      policy,
      trustedRootsPem: [pemOf(root)],
      now: NOW,
    })

    expect(result.ok).toBe(false)
  })
})
