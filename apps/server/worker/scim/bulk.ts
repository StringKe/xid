// SCIM 2.0 Bulk 端点(RFC 7644 3.7):POST /scim/v2/organizations/{organization_id}/Bulk
// 子请求在同一 ExecutionContext 内分派,审计、webhook 与出站同步入队仍由 waitUntil 保活。

import type { Result } from '@xid-kit/types'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { authBearer } from './auth'
import { isRecord, parseScimJsonObject } from './scim-json'
import {
  readExecutionContext,
  SCIM_BULK_MAX_OPERATIONS,
  SCIM_BULK_MAX_PAYLOAD_SIZE,
  SCIM_JSON_HEADERS,
  scimError,
  scimErrorBody,
} from './shared'

const BULK_REQUEST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest'
const BULK_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:BulkResponse'
const BULK_ID_PREFIX = 'bulkId:'

// schemas 必须含 BulkRequest URN;method 归一化为大写后限四种。失败映射 scimError invalidSyntax。
const bulkSchemasSchema = v.pipe(
  v.array(v.string()),
  v.check((list) => list.includes(BULK_REQUEST_SCHEMA)),
)

const optionalString = v.optional(
  v.pipe(
    v.unknown(),
    v.transform((value) => (typeof value === 'string' ? value : undefined)),
  ),
)

const bulkOperationSchema = v.looseObject({
  method: v.pipe(
    v.string(),
    v.transform((value) => value.toUpperCase()),
    v.picklist(['POST', 'PUT', 'PATCH', 'DELETE']),
  ),
  path: v.pipe(v.string(), v.startsWith('/')),
  bulkId: optionalString,
  version: optionalString,
  data: v.optional(v.unknown()),
})

type BulkOperation = v.InferOutput<typeof bulkOperationSchema>

// RFC 7644 3.7.3:failOnErrors 是可接受的错误数,达到后停止处理剩余操作。
const failOnErrorsSchema = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)))

type BulkResponseOperation = {
  method: string
  bulkId?: string
  version?: string
  location?: string
  status: string
  response?: unknown
}

type CreatedResource = { id: string; location: string }

function resolveBulkPath(
  path: string,
  orgBase: string,
  created: ReadonlyMap<string, CreatedResource>,
): string | null {
  let resolved = path
  const bulkRef = /\/bulkId:([^/]+)/.exec(path)
  if (bulkRef) {
    const resource = created.get(bulkRef[1] ?? '')
    if (!resource) return null
    try {
      const suffix = path.slice(bulkRef.index + bulkRef[0].length)
      resolved = `${new URL(resource.location).pathname}${suffix}`
    } catch {
      return null
    }
  }
  if (resolved.startsWith(orgBase)) return resolved
  return `${orgBase}${resolved}`
}

// data 中任意位置的 "bulkId:<id>" 替换为已创建资源的 id(RFC 7644 3.7.2)。
function resolveBulkData(
  value: unknown,
  created: ReadonlyMap<string, CreatedResource>,
): Result<unknown, string> {
  if (typeof value === 'string' && value.startsWith(BULK_ID_PREFIX)) {
    const resource = created.get(value.slice(BULK_ID_PREFIX.length))
    return resource ? { ok: true, value: resource.id } : { ok: false, error: value }
  }
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value) {
      const resolved = resolveBulkData(item, created)
      if (!resolved.ok) return resolved
      items.push(resolved.value)
    }
    return { ok: true, value: items }
  }
  if (!isRecord(value)) return { ok: true, value }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const resolved = resolveBulkData(item, created)
    if (!resolved.ok) return resolved
    output[key] = resolved.value
  }
  return { ok: true, value: output }
}

function errorOperation(op: BulkOperation, status: number, scimType: string, detail: string) {
  return {
    method: op.method,
    bulkId: op.bulkId,
    version: op.version,
    status: String(status),
    response: scimErrorBody(status, detail, scimType),
  }
}

async function dispatch(
  app: Hono<XidHonoEnv>,
  c: Context<XidHonoEnv>,
  request: { op: BulkOperation; path: string; data: unknown },
): Promise<Response> {
  const headers = new Headers(c.req.raw.headers)
  headers.set('Content-Type', 'application/scim+json')
  headers.delete('Content-Length')
  if (request.op.version) headers.set('If-Match', request.op.version)
  const init: RequestInit = { method: request.op.method, headers }
  if (request.op.method !== 'DELETE' && request.data !== undefined) {
    init.body = JSON.stringify(request.data)
  }
  return app.request(
    new URL(request.path, c.req.url).toString(),
    init,
    c.env,
    readExecutionContext(c),
  )
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { detail: text }
  }
}

function createdResource(response: Response, body: unknown): CreatedResource | null {
  if (response.status < 200 || response.status >= 300 || !isRecord(body)) return null
  const id = body['id']
  const meta = isRecord(body['meta']) ? body['meta'] : {}
  const location = response.headers.get('Location') ?? meta['location']
  return typeof id === 'string' && typeof location === 'string' ? { id, location } : null
}

async function runOperation(
  app: Hono<XidHonoEnv>,
  c: Context<XidHonoEnv>,
  input: { op: BulkOperation; orgBase: string; created: Map<string, CreatedResource> },
): Promise<BulkResponseOperation> {
  const { op, orgBase, created } = input
  const path = resolveBulkPath(op.path, orgBase, created)
  if (!path || !path.startsWith(`${orgBase}/`)) {
    return errorOperation(op, 400, 'invalidPath', 'Invalid bulk operation path')
  }
  const data = resolveBulkData(op.data, created)
  if (!data.ok) {
    return errorOperation(op, 409, 'invalidValue', `Unresolved bulkId reference: ${data.error}`)
  }
  const response = await dispatch(app, c, { op, path, data: data.value })
  const body = await readResponseBody(response)
  const resource = createdResource(response, body)
  if (op.bulkId && resource) created.set(op.bulkId, resource)
  return {
    method: op.method,
    bulkId: op.bulkId,
    version: op.version,
    location: resource?.location ?? response.headers.get('Location') ?? undefined,
    status: String(response.status),
    response: body,
  }
}

export function registerScimBulkRoutes(app: Hono<XidHonoEnv>, basePath: string): void {
  app.post(`${basePath}/Bulk`, async (c) => {
    const tenantId = c.req.param('organization_id')
    if (tenantId !== c.get('tenant').tenantId) return scimError(c, 403, 'organization mismatch')
    if (!(await authBearer(c, tenantId))) {
      return scimError(c, 401, 'Unauthorized', { addWwwAuth: true })
    }

    const rawBody = await c.req.text()
    if (rawBody.length > SCIM_BULK_MAX_PAYLOAD_SIZE) {
      return scimError(c, 413, 'Bulk payload exceeds maxPayloadSize', 'tooLarge')
    }
    const body = parseScimJsonObject(rawBody)
    if (!body) return scimError(c, 400, 'Invalid BulkRequest JSON', 'invalidSyntax')
    if (!v.safeParse(bulkSchemasSchema, body['schemas']).success) {
      return scimError(c, 400, 'Missing BulkRequest schema', 'invalidSyntax')
    }
    const failOnErrors = v.safeParse(failOnErrorsSchema, body['failOnErrors'])
    if (!failOnErrors.success) {
      return scimError(c, 400, 'failOnErrors must be a positive integer', 'invalidValue')
    }
    const operationsResult = v.safeParse(v.array(bulkOperationSchema), body['Operations'])
    if (!operationsResult.success) {
      return scimError(c, 400, 'Invalid Bulk Operations', 'invalidSyntax')
    }
    const operations = operationsResult.output
    if (operations.length === 0) {
      return scimError(c, 400, 'Bulk Operations must not be empty', 'invalidSyntax')
    }
    if (operations.length > SCIM_BULK_MAX_OPERATIONS) {
      return scimError(c, 413, 'Bulk Operations exceed maxOperations', 'tooMany')
    }

    const errorLimit = failOnErrors.output ?? Number.POSITIVE_INFINITY
    const orgBase = basePath.replace(':organization_id', tenantId)
    const created = new Map<string, CreatedResource>()
    const results: BulkResponseOperation[] = []
    let errors = 0
    for (const op of operations) {
      const result = await runOperation(app, c, { op, orgBase, created })
      results.push(result)
      if (Number(result.status) >= 400) errors += 1
      if (errors >= errorLimit) break
    }
    return c.json({ schemas: [BULK_RESPONSE_SCHEMA], Operations: results }, 200, SCIM_JSON_HEADERS)
  })
}
