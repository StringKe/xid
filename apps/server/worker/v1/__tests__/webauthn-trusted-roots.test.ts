// /v1/webauthn/trusted-roots:写入前校验 PEM(当前有效的 CA),按 tenant_id 分 KV key,写入需要 organizations:write。

import { describe, expect, it, vi } from 'vitest'
import { registerWebAuthnTrustedRootRoutes, trustedRootsKvKey } from '../webauthn-trusted-roots'
import { TENANT_B, buildApp, envOf, makeDb, seedApiKey, seedOrg } from './console-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const URL_BASE = 'https://acme.xid.dev/v1/webauthn/trusted-roots'

// 自签 P-256 证书,CN=Vendor Attestation Root。有效 CA 与非 CA 有效期 2025-2099,过期 CA 2020-2021。
const VALID_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBRzCB7qADAgECAgEBMAoGCCqGSM49BAMCMCIxIDAeBgNVBAMTF1ZlbmRvciBB
dHRlc3RhdGlvbiBSb290MCAXDTI1MDEwMTAwMDAwMFoYDzIwOTkwMTAxMDAwMDAw
WjAiMSAwHgYDVQQDExdWZW5kb3IgQXR0ZXN0YXRpb24gUm9vdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABCFBa6cspzmcjx1Pgiaklp1JxcrwwMZ+o6kLXqGnP/nT
2potEt3tyWoYmSmD1stTHfMRdm079Rk+Xxd9nt3LfNOjEzARMA8GA1UdEwEB/wQF
MAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgdtORlCQkhSH7i25H360y+wjpJktzuVWp
JhvBU1e9xCsCIQCfFCgQ1jxDM50Zmi16vZ71wr+3HHdQ9LOtsXXIOj+Z/g==
-----END CERTIFICATE-----`

const NON_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBRDCB66ADAgECAgEBMAoGCCqGSM49BAMCMCIxIDAeBgNVBAMTF1ZlbmRvciBB
dHRlc3RhdGlvbiBSb290MCAXDTI1MDEwMTAwMDAwMFoYDzIwOTkwMTAxMDAwMDAw
WjAiMSAwHgYDVQQDExdWZW5kb3IgQXR0ZXN0YXRpb24gUm9vdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABP7Wvi2L75UPCNUyolIDsrjr4ojCeXAhpvGOW5pUQu3z
xIl6RcFkUsVa1Y2yKoLfb4sS7jW2XaKLpwjuaZYKqBajEDAOMAwGA1UdEwEB/wQC
MAAwCgYIKoZIzj0EAwIDSAAwRQIgUsD7A+mD7zRAWgmoTwvasWlz6HES/1lFqJh0
C8ptJiICIQCDSsNtea2IB5ASjSXPhv6evwnJfSix7M9vjb/Th9p7ug==
-----END CERTIFICATE-----`

const EXPIRED_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBRjCB7KADAgECAgEBMAoGCCqGSM49BAMCMCIxIDAeBgNVBAMTF1ZlbmRvciBB
dHRlc3RhdGlvbiBSb290MB4XDTIwMDEwMTAwMDAwMFoXDTIxMDEwMTAwMDAwMFow
IjEgMB4GA1UEAxMXVmVuZG9yIEF0dGVzdGF0aW9uIFJvb3QwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAQRr0QFJXl4YCtSV6Aut4NgqtmWHLJyHanMbIY8YFfICYp3
Lk4ml3zFyGcIzRQbwrFs6apN4aREOy2l7sbx5OoUoxMwETAPBgNVHRMBAf8EBTAD
AQH/MAoGCCqGSM49BAMCA0kAMEYCIQC+7Q1vK9eDuL17fkM1wyYYqBJm1vSnzMHi
s83K2Eg2SwIhAKv45qUN7k12CnPPj+XH1R6+urP6Oj2c9rpud1w8vLrL
-----END CERTIFICATE-----`

function memoryKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

async function setup(scopes: string[] = ['organizations:write', 'organizations:read']) {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a' })
  await seedOrg(d1, { id: 't_b', tenant: TENANT_B })
  const token = await seedApiKey(d1, { id: 'ak_roots', scopes })
  const kv = memoryKv()
  const env = { ...envOf(d1), CACHE: kv } as unknown as Env
  const app = buildApp(registerWebAuthnTrustedRootRoutes)
  const request = (init: RequestInit = {}) =>
    app.request(
      URL_BASE,
      {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      },
      env,
    )
  return { kv, request }
}

describe('/v1/webauthn/trusted-roots', () => {
  it('stores a valid CA bundle under the current tenant key and lists its fingerprint', async () => {
    const { kv, request } = await setup()
    const pem = VALID_CA_PEM

    const put = await request({ method: 'PUT', body: JSON.stringify({ pem }) })
    const get = await request()

    expect(put.status).toBe(200)
    expect(kv.store.get(trustedRootsKvKey('t_a'))).toBe(pem)
    expect(kv.store.has(trustedRootsKvKey('t_b'))).toBe(false)
    const body = (await get.json()) as { configured: boolean; data: { fingerprint: string }[] }
    expect(body.configured).toBe(true)
    expect(body.data[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(body)).not.toContain('BEGIN CERTIFICATE')
  })

  it.each([
    ['a non-CA certificate', NON_CA_PEM],
    ['an expired CA', EXPIRED_CA_PEM],
    ['text without a certificate', 'not a certificate'],
  ])('rejects %s with validation_failed', async (_label, pem) => {
    const { kv, request } = await setup()

    const res = await request({ method: 'PUT', body: JSON.stringify({ pem }) })

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      code: 'validation_failed',
      meta: { paramName: 'pem' },
    })
    expect(kv.store.size).toBe(0)
  })

  it('reports not configured for a tenant whose roots belong to another tenant', async () => {
    const { kv, request } = await setup()
    kv.store.set(trustedRootsKvKey('t_b'), VALID_CA_PEM)

    const res = await request()

    expect(await res.json()).toEqual({ configured: false, data: [] })
  })

  it('rejects writes from a key without organizations:write', async () => {
    const { kv, request } = await setup(['organizations:read'])

    const res = await request({
      method: 'PUT',
      body: JSON.stringify({ pem: VALID_CA_PEM }),
    })

    expect(res.status).toBe(403)
    expect(kv.store.size).toBe(0)
  })

  it('deletes the tenant roots', async () => {
    const { kv, request } = await setup()
    kv.store.set(trustedRootsKvKey('t_a'), VALID_CA_PEM)

    const res = await request({ method: 'DELETE' })

    expect(res.status).toBe(204)
    expect(kv.store.has(trustedRootsKvKey('t_a'))).toBe(false)
  })
})
