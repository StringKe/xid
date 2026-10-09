// pollSamlIdpMetadata 负路径与隔离:拉取失败、无效 XML、超大 metadata、分页、单连接错误不阻断整轮。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSelfSignedSamlCertificate } from '@xid-kit/saml'
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

function configUpdates(db: FakeD1): Prepared[] {
  return db.runs.filter((run) => run.sql.includes('SET idp_entity_id'))
}

function failureUpdates(db: FakeD1): Prepared[] {
  return db.runs.filter((run) => run.sql.includes('SET idp_metadata_last_error = ?'))
}

function successUpdates(db: FakeD1): Prepared[] {
  return db.runs.filter((run) => run.sql.includes('SET idp_metadata_refreshed_at = ?'))
}

function connection(overrides: Row = {}): Row {
  return {
    id: 'conn_1',
    tenant_id: 'tenant_1',
    org_id: 'org_1',
    idp_metadata_url: 'https://idp.example.com/metadata.xml',
    idp_entity_id: null,
    idp_sso_url: null,
    idp_slo_url: null,
    idp_certificates: '[]',
    ...overrides,
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

    expect(configUpdates(db)).toHaveLength(0)
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
    expect(configUpdates(db)).toHaveLength(0)
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

    expect(configUpdates(db)).toHaveLength(0)
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

    expect(configUpdates(db)).toHaveLength(0)
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

    expect(configUpdates(db)).toHaveLength(0)
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
    const updates = configUpdates(db)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.args.slice(5)).toEqual(['tenant_1', 'conn_b'])
    expect(failureUpdates(db).map((run) => run.args)).toEqual([
      ['metadata_too_large', expect.any(Number), 'tenant_1', 'conn_a'],
    ])
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
    expect(configUpdates(db)).toHaveLength(51)
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
    expect(configUpdates(db)).toHaveLength(1)
    expect(sent[0]?.['event']).toBe('connection.saml_certificate_renewed')
    expect(failureUpdates(db).map((run) => run.args)).toEqual([
      ['metadata_fetch_failed', expect.any(Number), 'tenant_1', 'conn_fail'],
    ])
  })
})

describe('pollSamlIdpMetadata refresh status', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('records the HTTP failure on the connection scoped by tenant and logs a warning', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 })) as typeof fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = new FakeD1([connection()])

    await pollSamlIdpMetadata(makeEnv(db))

    const [failure] = failureUpdates(db)
    expect(failure?.sql).toContain('WHERE tenant_id = ? AND id = ?')
    expect(failure?.args).toEqual([
      'metadata_http_status',
      expect.any(Number),
      'tenant_1',
      'conn_1',
    ])
    expect(successUpdates(db)).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cron.daily.saml_metadata_refresh_failed',
        reason: 'metadata_http_status',
        status: 503,
      }),
    )
  })

  it('records metadata_url_not_allowed for a stored URL that is no longer public', async () => {
    globalThis.fetch = vi.fn() as typeof fetch
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = new FakeD1([connection({ idp_metadata_url: 'https://10.0.0.1/metadata' })])

    await pollSamlIdpMetadata(makeEnv(db))

    expect(failureUpdates(db)[0]?.args[0]).toBe('metadata_url_not_allowed')
  })

  it('records metadata_invalid when the XML cannot be parsed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<nope/>')) as typeof fetch
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = new FakeD1([connection()])

    await pollSamlIdpMetadata(makeEnv(db))

    expect(failureUpdates(db)[0]?.args[0]).toBe('metadata_invalid')
  })

  it('only marks the refresh time when the metadata matches the stored configuration', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(idpMetadataXml('CERT_SAME'))) as typeof fetch
    const db = new FakeD1([
      connection({
        idp_entity_id: 'https://idp.example.com/metadata',
        idp_sso_url: 'https://idp.example.com/sso',
        idp_slo_url: 'https://idp.example.com/slo',
        idp_certificates: JSON.stringify(['CERT_SAME']),
      }),
    ])

    await pollSamlIdpMetadata(makeEnv(db))

    expect(configUpdates(db)).toHaveLength(0)
    const [success] = successUpdates(db)
    expect(success?.sql).toContain('idp_metadata_last_error = NULL')
    expect(success?.args).toEqual([expect.any(Number), 'tenant_1', 'conn_1'])
  })

  it('keeps the previous IdP certificate next to the rotated one until it expires', async () => {
    const previous = await generateSelfSignedSamlCertificate('idp-old.example.com')
    const rotated = await generateSelfSignedSamlCertificate('idp-new.example.com')
    if (!previous.ok || !rotated.ok) throw new Error('certificate generation failed')
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(idpMetadataXml(rotated.value.certificateB64))) as typeof fetch
    const db = new FakeD1([
      connection({ idp_certificates: JSON.stringify([previous.value.certificateB64]) }),
    ])
    const sent: Row[] = []

    await pollSamlIdpMetadata(makeEnv(db, sent))

    const [update] = configUpdates(db)
    expect(JSON.parse(String(update?.args[3]))).toEqual([
      rotated.value.certificateB64,
      previous.value.certificateB64,
    ])
    expect(sent.map((message) => message['event'])).toEqual(['connection.saml_certificate_renewed'])
  })

  it('removes an expired previous certificate without announcing a renewal', async () => {
    const expired = await generateSelfSignedSamlCertificate(
      'idp-old.example.com',
      Date.now() - 400 * 24 * 60 * 60 * 1000,
    )
    if (!expired.ok) throw new Error('certificate generation failed')
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(idpMetadataXml('CERT_CURRENT'))) as typeof fetch
    const db = new FakeD1([
      connection({
        idp_entity_id: 'https://idp.example.com/metadata',
        idp_sso_url: 'https://idp.example.com/sso',
        idp_slo_url: 'https://idp.example.com/slo',
        idp_certificates: JSON.stringify(['CERT_CURRENT', expired.value.certificateB64]),
      }),
    ])
    const sent: Row[] = []

    await pollSamlIdpMetadata(makeEnv(db, sent))

    expect(JSON.parse(String(configUpdates(db)[0]?.args[3]))).toEqual(['CERT_CURRENT'])
    expect(sent).toHaveLength(0)
  })

  it('binds tenant_id on the configuration update', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(idpMetadataXml('CERT_NEW'))) as typeof fetch
    const db = new FakeD1([connection({ tenant_id: 'tenant_9', id: 'conn_9' })])

    await pollSamlIdpMetadata(makeEnv(db))

    const [update] = configUpdates(db)
    expect(update?.sql).toContain('WHERE tenant_id = ? AND id = ?')
    expect(update?.args.slice(5)).toEqual(['tenant_9', 'conn_9'])
  })
})
