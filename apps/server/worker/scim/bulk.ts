// SCIM 2.0 Bulk endpoint (RFC 7644 §3.7)
// POST /scim/v2/organizations/{organization_id}/Bulk

import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import {
  authBearer,
  scimError,
  SCIM_BULK_MAX_OPERATIONS,
  SCIM_BULK_MAX_PAYLOAD_SIZE,
} from './shared'

const BULK_REQUEST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest'
const BULK_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:BulkResponse'

// Bulk 形状层:schemas 必须含 BulkRequest URN;Operations 每项 method/path 必填,
// method 归一化为大写后限四种(RFC7644 3.7)。data 原样透传给下游路由,bulkId/version
// 非 string 历史按缺失处理(宽松),不升级为形状错误。失败映射 scimError invalidSyntax,
// 不走 XidAPIError,故用 safeParse 自映射。
const bulkSchemasSchema = v.pipe(
  v.array(v.string()),
  v.check((list) => list.includes(BULK_REQUEST_SCHEMA)),
)

const bulkOperationSchema = v.looseObject({
  method: v.pipe(
    v.string(),
    v.transform((value) => value.toUpperCase()),
    v.picklist(['POST', 'PUT', 'PATCH', 'DELETE']),
  ),
  path: v.pipe(v.string(), v.startsWith('/')),
  bulkId: v.optional(
    v.pipe(
      v.unknown(),
      v.transform((value) => (typeof value === 'string' ? value : undefined)),
    ),
  ),
  version: v.optional(
    v.pipe(
      v.unknown(),
      v.transform((value) => (typeof value === 'string' ? value : undefined)),
    ),
  ),
  data: v.optional(v.unknown()),
})

type BulkResponseOperation = {
  method: string
  bulkId?: string
  version?: string
  location?: string
  status: string
  response?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function resolveBulkPath(
  path: string,
  orgBase: string,
  bulkLocations: Map<string, string>,
): string | null {
  let resolved = path
  const bulkRef = /\/bulkId:([^/]+)/.exec(path)
  if (bulkRef) {
    const bulkId = bulkRef[1]
    if (!bulkId) return null
    const location = bulkLocations.get(bulkId)
    if (!location) return null
    try {
      const locationUrl = new URL(location)
      const suffix = path.slice(bulkRef.index! + bulkRef[0].length)
      resolved = `${locationUrl.pathname}${suffix}`
    } catch {
      return null
    }
  }
  if (resolved.startsWith(orgBase)) return resolved
  if (resolved.startsWith('/')) return `${orgBase}${resolved}`
  return `${orgBase}/${resolved}`
}

type BulkDispatchRequest = {
  method: string
  path: string
  data?: unknown
  version?: string
}

function buildBulkRequest(c: Context<XidHonoEnv>, op: BulkDispatchRequest): Request {
  const url = new URL(op.path, c.req.url)
  const headers = new Headers(c.req.raw.headers)
  headers.set('Content-Type', 'application/scim+json')
  if (op.version) headers.set('If-Match', op.version)
  const init: RequestInit = { method: op.method, headers }
  if (op.method !== 'DELETE' && op.data !== undefined) {
    init.body = JSON.stringify(op.data)
  }
  return new Request(url, init)
}

export function registerScimBulkRoutes(app: Hono<XidHonoEnv>, basePath: string): void {
  app.post(`${basePath}/Bulk`, async (c) => {
    const tenantId = c.req.param('organization_id')
    const tenant = c.get('tenant')
    if (tenantId !== tenant.tenantId) return scimError(c, 403, 'organization mismatch')

    if (!(await authBearer(c, tenantId))) {
      return scimError(c, 401, 'Unauthorized', { addWwwAuth: true })
    }

    const rawBody = await c.req.text()
    if (rawBody.length > SCIM_BULK_MAX_PAYLOAD_SIZE) {
      return scimError(c, 413, 'Bulk payload exceeds maxPayloadSize', 'tooLarge')
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawBody)
    } catch {
      return scimError(c, 400, 'Invalid BulkRequest JSON', 'invalidSyntax')
    }
    const body = asRecord(parsedJson)
    if (!body) return scimError(c, 400, 'Invalid BulkRequest JSON', 'invalidSyntax')

    const schemasResult = v.safeParse(bulkSchemasSchema, body['schemas'])
    if (!schemasResult.success) {
      return scimError(c, 400, 'Missing BulkRequest schema', 'invalidSyntax')
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

    const failOnErrors = body['failOnErrors'] === true || body['failOnErrors'] === 1
    const orgBase = basePath.replace(':organization_id', tenantId)
    const bulkLocations = new Map<string, string>()
    const results: BulkResponseOperation[] = []

    for (const op of operations) {
      const resolvedPath = resolveBulkPath(op.path, orgBase, bulkLocations)
      if (!resolvedPath || !resolvedPath.startsWith(`${orgBase}/`)) {
        results.push({
          method: op.method,
          bulkId: op.bulkId,
          version: op.version,
          status: '400',
          response: {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '400',
            scimType: 'invalidPath',
            detail: 'Invalid bulk operation path',
          },
        })
        if (failOnErrors) break
        continue
      }

      const req = buildBulkRequest(c, {
        method: op.method,
        path: resolvedPath,
        data: op.data,
        version: op.version,
      })
      const response = await app.request(
        req.url,
        {
          method: req.method,
          headers: req.headers,
          body: req.method === 'DELETE' ? undefined : await req.text(),
        },
        c.env,
      )
      const responseText = await response.text()
      let responseBody: unknown = undefined
      if (responseText) {
        try {
          responseBody = JSON.parse(responseText) as unknown
        } catch {
          responseBody = { detail: responseText }
        }
      }

      const location = response.headers.get('Location') ?? undefined
      if (op.bulkId && location) bulkLocations.set(op.bulkId, location)
      if (op.bulkId && !location && response.status >= 200 && response.status < 300) {
        const bodyRecord = asRecord(responseBody)
        const meta = asRecord(bodyRecord?.['meta'])
        const metaLocation = meta?.['location']
        if (typeof metaLocation === 'string') bulkLocations.set(op.bulkId, metaLocation)
      }

      results.push({
        method: op.method,
        bulkId: op.bulkId,
        version: op.version,
        location,
        status: String(response.status),
        response: responseBody,
      })

      if (failOnErrors && response.status >= 400) break
    }

    return c.json(
      {
        schemas: [BULK_RESPONSE_SCHEMA],
        Operations: results,
      },
      200,
      { 'Content-Type': 'application/scim+json' },
    )
  })
}
