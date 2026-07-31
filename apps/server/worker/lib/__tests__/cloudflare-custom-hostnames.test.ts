import { describe, expect, it, vi } from 'vitest'
import {
  CloudflareCustomHostnameError,
  CloudflareCustomHostnamesClient,
  cloudflareForSaasConfigFromEnv,
  normalizeCustomHostname,
} from '../cloudflare-custom-hostnames'

function customHostnameEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    result: {
      id: 'cf_hostname_1',
      hostname: 'login.customer.example',
      status: 'pending',
      ownership_verification: {
        type: 'txt',
        name: '_cf-custom-hostname.login.customer.example',
        value: 'ownership-value',
      },
      ssl: {
        status: 'pending_validation',
        dcv_delegation_records: [
          {
            cname: '_acme-challenge.login.customer.example',
            cname_target: 'login.customer.example.dcv.cloudflare.com',
          },
        ],
        validation_records: [
          {
            status: 'pending',
            txt_name: '_acme-challenge.login.customer.example',
            txt_value: 'certificate-value',
          },
        ],
      },
      verification_errors: ['ownership verification pending'],
      ...overrides,
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

describe('Cloudflare for SaaS configuration', () => {
  it('treats an entirely absent optional configuration as disabled', () => {
    expect(cloudflareForSaasConfigFromEnv({})).toBeNull()
  })

  it('fails closed when only part of the configuration is present', () => {
    expect(() =>
      cloudflareForSaasConfigFromEnv({
        CLOUDFLARE_FOR_SAAS_ZONE_ID: 'zone_1',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<CloudflareCustomHostnameError>>({
        code: 'cloudflare_for_saas_configuration',
      }),
    )
  })

  it('normalizes a configured friendly CNAME target', () => {
    expect(
      cloudflareForSaasConfigFromEnv({
        CLOUDFLARE_FOR_SAAS_ZONE_ID: ' zone_1 ',
        CLOUDFLARE_FOR_SAAS_API_TOKEN: ' token_1 ',
        CLOUDFLARE_FOR_SAAS_CNAME_TARGET: ' CUSTOMERS.XID.TEST ',
      }),
    ).toEqual({
      zoneId: 'zone_1',
      apiToken: 'token_1',
      cnameTarget: 'customers.xid.test',
    })
  })
})

describe('custom hostname validation', () => {
  it('normalizes a valid external hostname', () => {
    expect(normalizeCustomHostname(' LOGIN.Customer.Example ', 'xid.test')).toBe(
      'login.customer.example',
    )
  })

  it.each([
    'https://login.customer.example',
    'login.customer.example/path',
    'login.customer.example:8443',
    'user@login.customer.example',
    '*.customer.example',
    '127.0.0.1',
    'localhost',
    'service.internal',
    'single-label',
    'login.xid.test',
    'xid.test',
  ])('rejects an unsafe or platform-owned hostname: %s', (hostname) => {
    expect(() => normalizeCustomHostname(hostname, 'xid.test')).toThrowError(
      expect.objectContaining<Partial<CloudflareCustomHostnameError>>({
        code: 'cloudflare_for_saas_invalid_hostname',
      }),
    )
  })
})

describe('CloudflareCustomHostnamesClient', () => {
  it('creates a hostname through the fixed Cloudflare API origin', async () => {
    const fetcher = vi.fn(async () => jsonResponse(customHostnameEnvelope()))
    const client = new CloudflareCustomHostnamesClient(
      {
        zoneId: 'zone/id',
        apiToken: 'token_1',
        cnameTarget: 'customers.xid.test',
      },
      fetcher,
    )

    const result = await client.create('login.customer.example')

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone%2Fid/custom_hostnames')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer token_1',
        'content-type': 'application/json',
      },
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      hostname: 'login.customer.example',
      ssl: {
        method: 'txt',
        type: 'dv',
        settings: {
          min_tls_version: '1.2',
          tls_1_3: 'on',
          http2: 'on',
        },
      },
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({
      id: 'cf_hostname_1',
      hostname: 'login.customer.example',
      status: 'pending',
      sslStatus: 'pending_validation',
      ownershipVerification: {
        type: 'txt',
        name: '_cf-custom-hostname.login.customer.example',
        value: 'ownership-value',
      },
      dcvDelegationRecords: [
        {
          cname: '_acme-challenge.login.customer.example',
          cnameTarget: 'login.customer.example.dcv.cloudflare.com',
        },
      ],
      validationRecords: [
        {
          status: 'pending',
          txtName: '_acme-challenge.login.customer.example',
          txtValue: 'certificate-value',
        },
      ],
      verificationErrors: ['ownership verification pending'],
    })
  })

  it('uses the configured friendly CNAME without an API request', async () => {
    const fetcher = vi.fn()
    const client = new CloudflareCustomHostnamesClient(
      {
        zoneId: 'zone_1',
        apiToken: 'token_1',
        cnameTarget: 'customers.xid.test',
      },
      fetcher,
    )

    await expect(client.trafficCnameTarget()).resolves.toBe('customers.xid.test')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uses only an active fallback origin when no friendly CNAME is configured', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        success: true,
        result: { origin: 'fallback.xid.test', status: 'active' },
      }),
    )
    const client = new CloudflareCustomHostnamesClient(
      { zoneId: 'zone_1', apiToken: 'token_1' },
      fetcher,
    )

    await expect(client.trafficCnameTarget()).resolves.toBe('fallback.xid.test')
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone_1/custom_hostnames/fallback_origin',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('sends the Cloudflare-required empty JSON object when deleting', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true, result: {} }))
    const client = new CloudflareCustomHostnamesClient(
      { zoneId: 'zone_1', apiToken: 'token_1' },
      fetcher,
    )

    await client.delete('hostname/id')

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone_1/custom_hostnames/hostname%2Fid',
      expect.objectContaining({ method: 'DELETE', body: '{}' }),
    )
  })

  it('treats a missing remote hostname as an idempotent delete success', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: false }, 404))
    const client = new CloudflareCustomHostnamesClient(
      { zoneId: 'zone_1', apiToken: 'token_1' },
      fetcher,
    )

    await expect(client.delete('already_deleted')).resolves.toBeUndefined()
  })

  it('finds an exact hostname for ambiguous-create reconciliation', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        success: true,
        result: [
          customHostnameEnvelope().result,
          {
            ...customHostnameEnvelope().result,
            id: 'cf_hostname_other',
            hostname: 'other.customer.example',
          },
        ],
      }),
    )
    const client = new CloudflareCustomHostnamesClient(
      { zoneId: 'zone_1', apiToken: 'token_1' },
      fetcher,
    )

    await expect(client.findByHostname('login.customer.example')).resolves.toMatchObject({
      id: 'cf_hostname_1',
      hostname: 'login.customer.example',
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone_1/custom_hostnames?hostname=login.customer.example&per_page=2',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('maps HTTP, network, and invalid JSON failures to typed errors', async () => {
    const http = new CloudflareCustomHostnamesClient(
      { zoneId: 'zone_1', apiToken: 'token_1' },
      vi.fn(async () => jsonResponse({ success: false }, 429)),
    )
    await expect(http.get('id_1')).rejects.toMatchObject({
      code: 'cloudflare_for_saas_http',
      status: 429,
    })

    const network = new CloudflareCustomHostnamesClient(
      { zoneId: 'zone_1', apiToken: 'token_1' },
      vi.fn(async () => {
        throw new Error('private upstream detail')
      }),
    )
    await expect(network.get('id_1')).rejects.toMatchObject({
      code: 'cloudflare_for_saas_network',
    })

    const invalid = new CloudflareCustomHostnamesClient(
      { zoneId: 'zone_1', apiToken: 'token_1' },
      vi.fn(async () => new Response('not-json')),
    )
    await expect(invalid.get('id_1')).rejects.toMatchObject({
      code: 'cloudflare_for_saas_invalid_response',
    })
  })

  it('rejects structurally invalid success responses', async () => {
    const client = new CloudflareCustomHostnamesClient(
      { zoneId: 'zone_1', apiToken: 'token_1' },
      vi.fn(async () => jsonResponse({ success: true, result: { id: 1 } })),
    )

    await expect(client.get('id_1')).rejects.toMatchObject({
      code: 'cloudflare_for_saas_invalid_response',
    })
  })
})
