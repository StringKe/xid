// 早期在实例主域登记的 passkey(rp_id 为 NULL)在组织主机上仍可用:只有它们可以以实例主域为 rpId 验签;
// 新登记的凭证只能走组织 rpId;别的租户查不到凭证;以组织 rpId 验签通过的存量凭证回填 rp_id。
// 断言由真实 P-256 密钥签名,四项校验走 @xid-kit/webauthn 的真实实现。

import { base64UrlEncode, p1363ToDer } from '@xid-kit/crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../passkey-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../passkey-helpers')>()
  return { ...actual, consumeChallenge: vi.fn() }
})

import { consumeChallenge } from '../passkey-helpers'
import { verifyPasskeyAssertion } from '../passkey-assertion'
import type { TenantVar } from '../../lib/types'

const ACME_HOST = 'acme.xid.dev'
const ACME: TenantVar = {
  tenantId: 'org_acme',
  instanceId: 'inst_1',
  issuer: 'https://xid.dev',
  rpId: ACME_HOST,
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
} as unknown as TenantVar

function coseEs256(raw: Uint8Array): Uint8Array {
  return new Uint8Array([
    0xa5,
    0x01,
    0x02,
    0x03,
    0x26,
    0x20,
    0x01,
    0x21,
    0x58,
    0x20,
    ...raw.subarray(1, 33),
    0x22,
    0x58,
    0x20,
    ...raw.subarray(33, 65),
  ])
}

async function assertionFor(rpId: string, keys: CryptoKeyPair, challenge: Uint8Array) {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)),
  )
  const authData = new Uint8Array(37)
  authData.set(rpIdHash, 0)
  authData[32] = 0x01 | 0x04
  authData[36] = 7
  const clientDataJson = new TextEncoder().encode(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: base64UrlEncode(challenge),
      origin: `https://${ACME_HOST}`,
    }),
  )
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJson))
  const signed = new Uint8Array([...authData, ...clientDataHash])
  const signature = p1363ToDer(
    new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed),
    ),
  )
  return {
    clientDataJSON: base64UrlEncode(clientDataJson),
    authenticatorData: base64UrlEncode(authData),
    signature: base64UrlEncode(signature),
  }
}

async function setup(storedRpId: string | null, options: { found?: boolean } = {}) {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  vi.mocked(consumeChallenge).mockResolvedValue(base64UrlEncode(challenge))
  const row = {
    id: 'pk_1',
    userId: 'user_1',
    credentialId: 'cred_1',
    rpId: storedRpId,
    publicKey: Buffer.from(coseEs256(raw)),
    coseAlg: -7,
    aaguid: Buffer.alloc(16, 7),
    signCount: 1,
    credentialDeviceType: 'singleDevice',
  }
  const update = vi.fn(async () => [row])
  const db = {
    passkeyCredentials: {
      findOne: vi.fn(async () => (options.found === false ? undefined : row)),
      update,
    },
  }
  const c = {
    req: { url: `https://${ACME_HOST}/auth/passkey/verify` },
    env: { AUDIT_QUEUE: { send: vi.fn() } },
    executionCtx: { waitUntil: vi.fn() },
  }
  const verify = (rpId: string) =>
    assertionFor(rpId, keys, challenge).then((response) =>
      verifyPasskeyAssertion({
        c: c as never,
        tenant: ACME,
        db: db as never,
        challengeKey: 'auth:handle:org_acme',
        credentialId: 'cred_1',
        response,
      }),
    )
  return { verify, update }
}

describe('passkeys registered on the instance primary domain', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts an earlier credential asserted with the instance primary domain', async () => {
    const { verify, update } = await setup(null)

    const result = await verify('xid.dev')

    expect(result.verification.rpId).toBe('xid.dev')
    expect(update).toHaveBeenCalledWith(
      expect.not.objectContaining({ rpId: expect.anything() }),
      expect.anything(),
    )
  })

  it('records the organization rpId when an earlier credential signs for it', async () => {
    const { verify, update } = await setup(null)

    const result = await verify(ACME_HOST)

    expect(result.verification.rpId).toBe(ACME_HOST)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ rpId: ACME_HOST }),
      expect.anything(),
    )
  })

  it('rejects a credential registered for the organization when it uses the primary domain', async () => {
    const { verify } = await setup(ACME_HOST)

    await expect(verify('xid.dev')).rejects.toMatchObject({ code: 'invalid_credentials' })
  })

  it('accepts a credential registered for the organization with the organization rpId', async () => {
    const { verify } = await setup(ACME_HOST)

    const result = await verify(ACME_HOST)

    expect(result.verification.rpId).toBe(ACME_HOST)
  })

  it('rejects a credential that the tenant-scoped lookup cannot find', async () => {
    const { verify } = await setup(null, { found: false })

    await expect(verify('xid.dev')).rejects.toMatchObject({ code: 'invalid_credentials' })
  })

  it('rejects any other parent or sibling rpId', async () => {
    const { verify } = await setup(null)

    await expect(verify('other.xid.dev')).rejects.toMatchObject({ code: 'invalid_credentials' })
  })
})
