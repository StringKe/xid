import * as v from 'valibot'
import type { CloudflareForSaasEnv as SharedCloudflareForSaasEnv } from '@xid-kit/types'

export const CUSTOM_HOSTNAME_OWNERSHIP_TTL_MS = 24 * 60 * 60 * 1000
export const CUSTOM_HOSTNAME_API_TIMEOUT_MS = 5_000

export type CloudflareForSaasEnv = SharedCloudflareForSaasEnv

export type CloudflareForSaasConfig = {
  zoneId: string
  apiToken: string
  cnameTarget?: string
}

export type CloudflareDcvDelegationRecord = {
  cname: string
  cnameTarget: string
}

export type CloudflareValidationRecord = {
  status?: string
  txtName?: string
  txtValue?: string
  cname?: string
  cnameTarget?: string
}

export type CloudflareCustomHostnameDetails = {
  id: string
  hostname: string
  status: string
  sslStatus: string | null
  ownershipVerification: {
    type: string
    name: string
    value: string
  } | null
  dcvDelegationRecords: CloudflareDcvDelegationRecord[]
  validationRecords: CloudflareValidationRecord[]
  verificationErrors: string[]
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type CloudflareCustomHostnameErrorCode =
  | 'cloudflare_for_saas_configuration'
  | 'cloudflare_for_saas_invalid_hostname'
  | 'cloudflare_for_saas_network'
  | 'cloudflare_for_saas_http'
  | 'cloudflare_for_saas_invalid_response'

export class CloudflareCustomHostnameError extends Error {
  readonly code: CloudflareCustomHostnameErrorCode
  readonly status?: number

  constructor(
    code: CloudflareCustomHostnameErrorCode,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CloudflareCustomHostnameError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
  }
}

const ownershipVerificationSchema = v.looseObject({
  type: v.string(),
  name: v.string(),
  value: v.string(),
})

const dcvRecordSchema = v.looseObject({
  cname: v.optional(v.string()),
  cname_target: v.optional(v.string()),
  status: v.optional(v.string()),
  txt_name: v.optional(v.string()),
  txt_value: v.optional(v.string()),
})

const sslSchema = v.looseObject({
  status: v.optional(v.string()),
  dcv_delegation_records: v.optional(v.array(dcvRecordSchema)),
  validation_records: v.optional(v.array(dcvRecordSchema)),
})

const customHostnameSchema = v.looseObject({
  id: v.string(),
  hostname: v.string(),
  status: v.string(),
  ownership_verification: v.optional(ownershipVerificationSchema),
  verification_errors: v.optional(v.array(v.string())),
  ssl: v.optional(sslSchema),
})

const customHostnameEnvelopeSchema = v.looseObject({
  success: v.literal(true),
  result: customHostnameSchema,
})

const customHostnameListEnvelopeSchema = v.looseObject({
  success: v.literal(true),
  result: v.array(customHostnameSchema),
})

const fallbackOriginEnvelopeSchema = v.looseObject({
  success: v.literal(true),
  result: v.looseObject({
    origin: v.string(),
    status: v.string(),
  }),
})

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.internal',
  '.invalid',
  '.lan',
  '.local',
  '.localhost',
  '.onion',
  '.home',
] as const

function configurationError(): CloudflareCustomHostnameError {
  return new CloudflareCustomHostnameError('cloudflare_for_saas_configuration')
}

export function cloudflareForSaasConfigFromEnv(
  env: CloudflareForSaasEnv,
): CloudflareForSaasConfig | null {
  const zoneId = env.CLOUDFLARE_FOR_SAAS_ZONE_ID?.trim()
  const apiToken = env.CLOUDFLARE_FOR_SAAS_API_TOKEN?.trim()
  const cnameTarget = env.CLOUDFLARE_FOR_SAAS_CNAME_TARGET?.trim()
  if (!zoneId && !apiToken && !cnameTarget) return null
  if (!zoneId || !apiToken) throw configurationError()
  return {
    zoneId,
    apiToken,
    ...(cnameTarget ? { cnameTarget: normalizeDnsHostname(cnameTarget) } : {}),
  }
}

function isIpv4Like(hostname: string): boolean {
  return /^\d+(?:\.\d+){3}$/u.test(hostname)
}

function normalizeDnsHostname(input: string): string {
  const trimmed = input.trim().toLowerCase()
  if (
    trimmed === '' ||
    trimmed.length > 253 ||
    trimmed.endsWith('.') ||
    trimmed.includes('/') ||
    trimmed.includes(':') ||
    trimmed.includes('@') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    trimmed.includes('*')
  ) {
    throw new CloudflareCustomHostnameError('cloudflare_for_saas_configuration')
  }

  let normalized: string
  try {
    normalized = new URL(`https://${trimmed}`).hostname
  } catch (error) {
    throw new CloudflareCustomHostnameError('cloudflare_for_saas_configuration', { cause: error })
  }
  if (
    normalized === 'localhost' ||
    normalized.includes(':') ||
    isIpv4Like(normalized) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    throw new CloudflareCustomHostnameError('cloudflare_for_saas_configuration')
  }
  const labels = normalized.split('.')
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    ) ||
    /^\d+$/u.test(labels.at(-1) ?? '')
  ) {
    throw new CloudflareCustomHostnameError('cloudflare_for_saas_configuration')
  }
  return normalized
}

export function normalizeCustomHostname(input: string, primaryDomain: string): string {
  let hostname: string
  try {
    hostname = normalizeDnsHostname(input)
  } catch (error) {
    throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_hostname', {
      cause: error,
    })
  }
  const primary = normalizeDnsHostname(primaryDomain)
  if (hostname === primary || hostname.endsWith(`.${primary}`)) {
    throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_hostname')
  }
  return hostname
}

function normalizeDetails(
  input: v.InferOutput<typeof customHostnameSchema>,
): CloudflareCustomHostnameDetails {
  const delegation = (input.ssl?.dcv_delegation_records ?? []).flatMap((record) =>
    record.cname && record.cname_target
      ? [{ cname: record.cname, cnameTarget: record.cname_target }]
      : [],
  )
  const validation = (input.ssl?.validation_records ?? []).map((record) => ({
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.txt_name === undefined ? {} : { txtName: record.txt_name }),
    ...(record.txt_value === undefined ? {} : { txtValue: record.txt_value }),
    ...(record.cname === undefined ? {} : { cname: record.cname }),
    ...(record.cname_target === undefined ? {} : { cnameTarget: record.cname_target }),
  }))
  return {
    id: input.id,
    hostname: input.hostname.toLowerCase(),
    status: input.status,
    sslStatus: input.ssl?.status ?? null,
    ownershipVerification: input.ownership_verification ?? null,
    dcvDelegationRecords: delegation,
    validationRecords: validation,
    verificationErrors: input.verification_errors ?? [],
  }
}

export class CloudflareCustomHostnamesClient {
  private readonly baseUrl: string

  constructor(
    private readonly config: CloudflareForSaasConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(config.zoneId)}`
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.apiToken}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        signal: AbortSignal.timeout(CUSTOM_HOSTNAME_API_TIMEOUT_MS),
      })
    } catch (error) {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_network', { cause: error })
    }
    if (!response.ok) {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_http', {
        status: response.status,
      })
    }
    try {
      return await response.json()
    } catch (error) {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_response', {
        cause: error,
      })
    }
  }

  async trafficCnameTarget(): Promise<string> {
    if (this.config.cnameTarget) return this.config.cnameTarget
    const body = await this.request('/custom_hostnames/fallback_origin', { method: 'GET' })
    const parsed = v.safeParse(fallbackOriginEnvelopeSchema, body)
    if (!parsed.success || parsed.output.result.status !== 'active') {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_response')
    }
    return normalizeDnsHostname(parsed.output.result.origin)
  }

  async create(hostname: string): Promise<CloudflareCustomHostnameDetails> {
    const body = await this.request('/custom_hostnames', {
      method: 'POST',
      body: JSON.stringify({
        hostname,
        ssl: {
          method: 'txt',
          type: 'dv',
          settings: { min_tls_version: '1.2', tls_1_3: 'on', http2: 'on' },
        },
      }),
    })
    const parsed = v.safeParse(customHostnameEnvelopeSchema, body)
    if (!parsed.success) {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_response')
    }
    return normalizeDetails(parsed.output.result)
  }

  async get(id: string): Promise<CloudflareCustomHostnameDetails> {
    const body = await this.request(`/custom_hostnames/${encodeURIComponent(id)}`, {
      method: 'GET',
    })
    const parsed = v.safeParse(customHostnameEnvelopeSchema, body)
    if (!parsed.success) {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_response')
    }
    return normalizeDetails(parsed.output.result)
  }

  async findByHostname(hostname: string): Promise<CloudflareCustomHostnameDetails | null> {
    const query = new URLSearchParams({ hostname, per_page: '2' })
    const body = await this.request(`/custom_hostnames?${query.toString()}`, {
      method: 'GET',
    })
    const parsed = v.safeParse(customHostnameListEnvelopeSchema, body)
    if (!parsed.success) {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_response')
    }
    const exact = parsed.output.result.filter((item) => item.hostname.toLowerCase() === hostname)
    if (exact.length > 1) {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_response')
    }
    return exact[0] ? normalizeDetails(exact[0]) : null
  }

  async delete(id: string): Promise<void> {
    try {
      await this.request(`/custom_hostnames/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: '{}',
      })
    } catch (error) {
      // 上次可能已删远端对象但 D1 未更新;404 视为清理完成以便可恢复重试。
      if (
        error instanceof CloudflareCustomHostnameError &&
        error.code === 'cloudflare_for_saas_http' &&
        error.status === 404
      ) {
        return
      }
      throw error
    }
  }
}

export type CloudflareCustomHostnamesClientLike = Pick<
  CloudflareCustomHostnamesClient,
  'create' | 'get' | 'findByHostname' | 'delete' | 'trafficCnameTarget'
>

export function createCloudflareCustomHostnamesClient(
  env: CloudflareForSaasEnv,
): CloudflareCustomHostnamesClient {
  const config = cloudflareForSaasConfigFromEnv(env)
  if (!config) throw configurationError()
  return new CloudflareCustomHostnamesClient(config)
}
