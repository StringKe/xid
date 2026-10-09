// 出站 SCIM 下游协议层:请求、错误分类、按 externalId 发现与幂等 upsert。

import { trimLeadingSlashes, trimTrailingSlashes } from '../../shared/url'
import type { ScimTarget, ScimResourceType, SyncRuntime } from './outbound-mapping'
import { findMapping, persistMapping } from './outbound-mapping'
import { normalizeScimTargetBaseUrl } from './target-credentials'

const LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const OUTBOUND_TIMEOUT_MS = 15_000

export class OutboundScimRequestError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(
      statusCode === undefined
        ? 'outbound_scim_network_failure'
        : `outbound_scim_http_${statusCode}`,
    )
    this.name = 'OutboundScimRequestError'
  }
}

type DownstreamRequest = {
  environment: string | undefined
  target: ScimTarget
  token: string
}

function endpoint(target: ScimTarget, path: string, environment: string | undefined): string {
  const baseUrl = normalizeScimTargetBaseUrl(target.baseUrl, { environment })
  return `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(path)}`
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const delta = Number(value)
  if (Number.isInteger(delta) && delta >= 0) return Math.min(86_400, Math.max(1, delta))
  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) return undefined
  const seconds = Math.ceil((retryAt - Date.now()) / 1000)
  return Math.min(86_400, Math.max(1, seconds))
}

export async function scimFetch(
  request: DownstreamRequest & {
    path: string
    init: RequestInit
    acceptedStatuses?: readonly number[]
  },
): Promise<Response> {
  const headers = new Headers(request.init.headers)
  headers.set('Authorization', `Bearer ${request.token}`)
  headers.set('Content-Type', 'application/scim+json')
  let res: Response
  try {
    res = await fetch(endpoint(request.target, request.path, request.environment), {
      ...request.init,
      headers,
      signal: request.init.signal ?? AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    })
  } catch {
    throw new OutboundScimRequestError(undefined, true, undefined)
  }
  const accepted = request.acceptedStatuses ?? []
  if ((res.status < 200 || res.status >= 300) && !accepted.includes(res.status)) {
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500
    throw new OutboundScimRequestError(
      res.status,
      retryable,
      res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After')) : undefined,
    )
  }
  return res
}

export function resourcePath(type: ScimResourceType): 'Users' | 'Groups' {
  return type === 'User' ? 'Users' : 'Groups'
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // The downstream body is intentionally not included in logs or client errors.
  }
  throw new OutboundScimRequestError(502, true, undefined)
}

function escapeScimFilterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

type ResourceRequest = DownstreamRequest & { resourceType: ScimResourceType }

async function discoverDownstreamId(
  request: ResourceRequest & { externalId: string },
): Promise<string | undefined> {
  const filter = `externalId eq "${escapeScimFilterValue(request.externalId)}"`
  const response = await scimFetch({
    ...request,
    path: `/${resourcePath(request.resourceType)}?filter=${encodeURIComponent(filter)}`,
    init: { method: 'GET' },
  })
  const body = await responseObject(response)
  const resources = body['Resources']
  if (!Array.isArray(resources)) throw new OutboundScimRequestError(502, true, undefined)
  if (Array.isArray(body['schemas']) && !body['schemas'].includes(LIST_RESPONSE_SCHEMA)) {
    throw new OutboundScimRequestError(502, true, undefined)
  }
  const ids = resources.flatMap((resource) => {
    if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) return []
    const id = (resource as Record<string, unknown>)['id']
    return typeof id === 'string' && id.length > 0 ? [id] : []
  })
  if (ids.length > 1) throw new OutboundScimRequestError(409, false, undefined)
  return ids[0]
}

async function replaceDownstreamResource(
  request: ResourceRequest & { downstreamId: string; body: Record<string, unknown> },
): Promise<boolean> {
  const response = await scimFetch({
    ...request,
    path: `/${resourcePath(request.resourceType)}/${encodeURIComponent(request.downstreamId)}`,
    init: { method: 'PUT', body: JSON.stringify(request.body) },
    acceptedStatuses: [404],
  })
  return response.status !== 404
}

async function createDownstreamResource(
  request: ResourceRequest & { externalId: string; body: Record<string, unknown> },
): Promise<string> {
  const response = await scimFetch({
    ...request,
    path: `/${resourcePath(request.resourceType)}`,
    init: { method: 'POST', body: JSON.stringify(request.body) },
    acceptedStatuses: [409],
  })
  if (response.status === 409) {
    const discovered = await discoverDownstreamId(request)
    if (!discovered) throw new OutboundScimRequestError(409, false, undefined)
    if (!(await replaceDownstreamResource({ ...request, downstreamId: discovered }))) {
      throw new OutboundScimRequestError(502, true, undefined)
    }
    return discovered
  }
  const created = await responseObject(response)
  if (typeof created['id'] === 'string' && created['id'].length > 0) return created['id']
  const discovered = await discoverDownstreamId(request)
  if (discovered) return discovered
  throw new OutboundScimRequestError(502, true, undefined)
}

export type UpsertInput = {
  resourceType: ScimResourceType
  localResourceId: string
  externalId: string
  body: Record<string, unknown>
  status: 'active' | 'deprovisioned'
}

export async function upsertResource(
  runtime: Pick<SyncRuntime, 'env' | 'db' | 'target' | 'token'>,
  input: UpsertInput,
): Promise<string> {
  const { env, db, target, token } = runtime
  const request: ResourceRequest = {
    environment: env.ENVIRONMENT,
    target,
    token,
    resourceType: input.resourceType,
  }
  const existing = await findMapping(db, target, input.resourceType, input.localResourceId)
  const mapping = { db, target, ...input, existing }
  let downstreamId = existing?.downstreamId
  if (
    downstreamId &&
    (await replaceDownstreamResource({ ...request, downstreamId, body: input.body }))
  ) {
    await persistMapping({ ...mapping, downstreamId })
    return downstreamId
  }
  downstreamId = await discoverDownstreamId({ ...request, externalId: input.externalId })
  if (downstreamId) {
    if (!(await replaceDownstreamResource({ ...request, downstreamId, body: input.body }))) {
      throw new OutboundScimRequestError(502, true, undefined)
    }
  } else {
    downstreamId = await createDownstreamResource({
      ...request,
      externalId: input.externalId,
      body: input.body,
    })
  }
  await persistMapping({ ...mapping, downstreamId })
  return downstreamId
}
