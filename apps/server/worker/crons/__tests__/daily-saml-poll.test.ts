// pollSamlIdpMetadata 负路径与隔离:拉取失败、无效 XML、超大 metadata、分页、单连接错误不阻断整轮。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollSamlIdpMetadata } from '../daily'

type Row = Record<string, unknown>

type Prepared = {
  sql: string
  args: unknown[]
}

function makeStatement(sql: string, env: FakeD1) {
  return {
    bind: (...args: unknown[]) => ({
      all: <T>() => env.all<T>(sql, args),
      run: () => env.run(sql, args),
    }),
    all: <T>() => env.all<T>(sql, []),
    run: () => env.run(sql, []),
  }
}

class FakeD1 {
  readonly runs: Prepared[] = []

  constructor(private readonly connections: Row[] = []) {}

  prepare(sql: string) {
    return makeStatement(sql, this)
  }

  all<T>(_sql: string, args: unknown[]) {
    const limit = Number(args[args.length - 1] ?? 50)
    const cursor = typeof args[0] === 'string' && args.length > 1 ? args[0] : null
    const rows = this.connections.filter((row) => cursor === null || String(row['id']) > cursor)
    return Promise.resolve({ results: rows.slice(0, limit) as T[] })
  }

  run(sql: string, args: unknown[]) {
    this.runs.push({ sql, args })
    return Promise.resolve({ success: true })
  }
}

function idpMetadataXml(
  cert: string,
  ssoUrl = 'https://idp.example.com/sso',
  sloUrl = 'https://idp.example.com/slo',
): string {
  return [
    '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.example.com/metadata">',
    '<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
    '<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>',
    cert,
    '</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>',
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>`,
    `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sloUrl}"/>`,
    '</md:IDPSSODescriptor>',
    '</md:EntityDescriptor>',
  ].join('')
}

function oversizedMetadataResponse(): Response {
  const chunk = new Uint8Array(512 * 1024)
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk)
      controller.enqueue(chunk)
      controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream)
}

function makeEnv(db: FakeD1, sent: Row[] = []): Env {
  return {
    DB: db,
    WEBHOOK_QUEUE: {
      send: (msg: Row) => {
        sent.push(msg)
        return Promise.resolve()
      },
    },
  } as unknown as Env
}

describe('pollSamlIdpMetadata negative paths', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('skips UPDATE when metadata fetch returns non-OK', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 })) as typeof fetch
    const db = new FakeD1([
      {
        id: 'conn_1',
        tenant_id: 'tenant_1',
        org_id: 'org_1',
        idp_metadata_url: 'https://idp.example.com/metadata.xml',
        idp_certificates: '[]',
      },
    ])

    await pollSamlIdpMetadata(makeEnv(db))

    expect(db.runs.some((run) => run.sql.includes('UPDATE sso_connections'))).toBe(false)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://idp.example.com/metadata.xml',
      expect.objectContaining({
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('does not fetch a non-public stored metadata URL', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as typeof fetch
    const db = new FakeD1([
      {
        id: 'conn_1',
        tenant_id: 'tenant_1',
        org_id: 'org_1',
        idp_metadata_url: 'https://169.254.169.254/latest/meta-data',
        idp_certificates: '[]',
      },
    ])

    await pollSamlIdpMetadata(makeEnv(db))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.runs.some((run) => run.sql.includes('UPDATE sso_connections'))).toBe(false)
  })

  it('does not persist a non-public SSO URL from otherwise valid metadata', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(idpMetadataXml('CERT_OK', 'https://127.0.0.1/sso')),
      ) as typeof fetch
    const db = new FakeD1([
      {
        id: 'conn_1',
        tenant_id: 'tenant_1',
        org_id: 'org_1',
        idp_metadata_url: 'https://idp.example.com/metadata.xml',
        idp_certificates: '[]',
      },
    ])

    await pollSamlIdpMetadata(makeEnv(db))

    expect(db.runs.some((run) => run.sql.includes('UPDATE sso_connections'))).toBe(false)
  })

  it('does not persist a non-public SLO URL from otherwise valid metadata', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          idpMetadataXml('CERT_OK', 'https://idp.example.com/sso', 'https://127.0.0.1/slo'),
        ),
      ) as typeof fetch
    const db = new FakeD1([
      {
        id: 'conn_1',
        tenant_id: 'tenant_1',
        org_id: 'org_1',
        idp_metadata_url: 'https://idp.example.com/metadata.xml',
        idp_certificates: '[]',
      },
    ])

    await pollSamlIdpMetadata(makeEnv(db))

    expect(db.runs.some((run) => run.sql.includes('UPDATE sso_connections'))).toBe(false)
  })

  it('skips UPDATE when metadata XML cannot be parsed', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('<not-saml-metadata/>')) as typeof fetch
    const db = new FakeD1([
      {
        id: 'conn_1',
        tenant_id: 'tenant_1',
        org_id: 'org_1',
        idp_metadata_url: 'https://idp.example.com/metadata.xml',
        idp_certificates: '[]',
      },
    ])

    await pollSamlIdpMetadata(makeEnv(db))

    expect(db.runs.some((run) => run.sql.includes('UPDATE sso_connections'))).toBe(false)
  })

  it('isolates metadata_too_large per connection without blocking siblings', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(oversizedMetadataResponse())
      .mockResolvedValueOnce(new Response(idpMetadataXml('CERT_OK')))
    globalThis.fetch = fetchMock as typeof fetch

    const db = new FakeD1([
      {
        id: 'conn_a',
        tenant_id: 'tenant_1',
        org_id: 'org_1',
        idp_metadata_url: 'https://idp-a.example.com/metadata.xml',
        idp_certificates: '[]',
      },
      {
        id: 'conn_b',
        tenant_id: 'tenant_1',
        org_id: 'org_1',
        idp_metadata_url: 'https://idp-b.example.com/metadata.xml',
        idp_certificates: JSON.stringify(['CERT_OLD']),
      },
    ])

    await pollSamlIdpMetadata(makeEnv(db))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const updates = db.runs.filter((run) => run.sql.includes('UPDATE sso_connections'))
    expect(updates).toHaveLength(1)
    expect(updates[0]?.args[5]).toBe('conn_b')
  })

  it('paginates active SAML connections in id order', async () => {
    const connections = Array.from({ length: 51 }, (_, index) => ({
      id: `conn_${String(index + 1).padStart(2, '0')}`,
      tenant_id: 'tenant_1',
      org_id: 'org_1',
      idp_metadata_url: `https://idp.example.com/${index + 1}.xml`,
      idp_certificates: JSON.stringify(['CERT_SAME']),
    }))
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(idpMetadataXml('CERT_SAME'))),
      ) as typeof fetch
    const db = new FakeD1(connections)

    await pollSamlIdpMetadata(makeEnv(db))

    expect(globalThis.fetch).toHaveBeenCalledTimes(51)
    expect(db.runs.filter((run) => run.sql.includes('UPDATE sso_connections'))).toHaveLength(51)
  })

  it('continues polling when one connection fetch throws', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network_down'))
      .mockResolvedValueOnce(new Response(idpMetadataXml('CERT_RECOVERED')))
    globalThis.fetch = fetchMock as typeof fetch

    const db = new FakeD1([
      {
        id: 'conn_fail',
        tenant_id: 'tenant_1',
        org_id: 'org_1',
        idp_metadata_url: 'https://idp-fail.example.com/metadata.xml',
        idp_certificates: '[]',
      },
      {
        id: 'conn_ok',
        tenant_id: 'tenant_1',
        org_id: 'org_1',
        idp_metadata_url: 'https://idp-ok.example.com/metadata.xml',
        idp_certificates: JSON.stringify(['CERT_OLD']),
      },
    ])
    const sent: Row[] = []

    await pollSamlIdpMetadata(makeEnv(db, sent))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(db.runs.filter((run) => run.sql.includes('UPDATE sso_connections'))).toHaveLength(1)
    expect(sent[0]?.['event']).toBe('connection.saml_certificate_renewed')
  })
})
