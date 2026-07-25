// OAuth RAR(RFC9396) authorization_details validation.
// XID currently supports one AS-controlled type: `resource_access`.

import { createTenantDb, schema } from '@xid-kit/db'
import type { AuthorizationDetails, Result, XidError } from '@xid-kit/types'
import { inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'

const SUPPORTED_AUTHORIZATION_DETAILS_TYPES = ['resource_access'] as const
const RESOURCE_ACCESS_FIELDS = new Set(['type', 'locations', 'actions'])
const MAX_AUTHORIZATION_DETAILS_ITEMS = 10
const MAX_AUTHORIZATION_DETAILS_VALUES = 100
const MAX_AUTHORIZATION_DETAILS_STRING_LENGTH = 512

export type AuthorizationDetailsResult = Result<readonly AuthorizationDetails[], XidError>
type StringArrayResult = Result<readonly string[], XidError>

export function authorizationDetailsTypesSupported(): readonly string[] {
  return SUPPORTED_AUTHORIZATION_DETAILS_TYPES
}

function invalidAuthorizationDetails(message: string): Result<never, XidError> {
  return {
    ok: false,
    error: { code: 'invalid_authorization_details', message, httpStatus: 400 },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStringArray(value: unknown, field: string): StringArrayResult {
  if (!Array.isArray(value) || value.length === 0) {
    return invalidAuthorizationDetails(`authorization_details ${field} must be a non-empty array`)
  }
  if (value.length > MAX_AUTHORIZATION_DETAILS_VALUES) {
    return invalidAuthorizationDetails(`authorization_details ${field} contains too many values`)
  }
  const out: string[] = []
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > MAX_AUTHORIZATION_DETAILS_STRING_LENGTH
    ) {
      return invalidAuthorizationDetails(`authorization_details ${field} contains an invalid value`)
    }
    out.push(item)
  }
  return { ok: true, value: out }
}

function rejectUnknownFields(item: Record<string, unknown>): XidError | null {
  for (const key of Object.keys(item)) {
    if (!RESOURCE_ACCESS_FIELDS.has(key)) {
      return {
        code: 'invalid_authorization_details',
        message: `authorization_details resource_access field ${key} is not supported`,
        httpStatus: 400,
      }
    }
  }
  return null
}

async function validateResourceAccess(
  c: Context<XidHonoEnv>,
  item: Record<string, unknown>,
): Promise<AuthorizationDetailsResult> {
  const fieldError = rejectUnknownFields(item)
  if (fieldError) return { ok: false, error: fieldError }
  const locations = readStringArray(item['locations'], 'locations')
  if (!locations.ok) return locations
  const actions = readStringArray(item['actions'], 'actions')
  if (!actions.ok) return actions

  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const uniqueLocations = [...new Set(locations.value)]
  const resources = await db.resourceServers.findMany(
    inArray(schema.resourceServers.audience, uniqueLocations),
    { limit: uniqueLocations.length },
  )
  const resourceByAudience = new Map(resources.map((resource) => [resource.audience, resource]))
  for (const location of locations.value) {
    const resource = resourceByAudience.get(location)
    if (!resource) {
      return invalidAuthorizationDetails(
        'authorization_details locations must reference registered resource audiences',
      )
    }
    const allowedScopes = new Set(resource.scopes)
    for (const action of actions.value) {
      if (!allowedScopes.has(action)) {
        return invalidAuthorizationDetails(
          'authorization_details actions must be allowed by the resource audience',
        )
      }
    }
  }

  return {
    ok: true,
    value: [
      {
        type: 'resource_access',
        locations: locations.value,
        actions: actions.value,
      },
    ],
  }
}

export async function parseAuthorizationDetails(
  c: Context<XidHonoEnv>,
  raw: string | undefined,
): Promise<AuthorizationDetailsResult> {
  if (raw === undefined || raw === '') return { ok: true, value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return invalidAuthorizationDetails('authorization_details must be valid JSON')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return invalidAuthorizationDetails('authorization_details must be a non-empty array')
  }
  if (parsed.length > MAX_AUTHORIZATION_DETAILS_ITEMS) {
    return invalidAuthorizationDetails('authorization_details contains too many entries')
  }

  const out: AuthorizationDetails[] = []
  for (const item of parsed) {
    if (!isRecord(item))
      return invalidAuthorizationDetails('authorization_details item must be an object')
    if (item['type'] !== 'resource_access') {
      return invalidAuthorizationDetails('authorization_details type is not supported')
    }
    const validated = await validateResourceAccess(c, item)
    if (!validated.ok) return validated
    out.push(...validated.value)
  }
  return { ok: true, value: out }
}

export function authorizationDetailsResources(
  details: readonly AuthorizationDetails[],
): readonly string[] {
  return Array.from(new Set(details.flatMap((item) => [...item.locations])))
}

export function authorizationDetailsScopes(
  details: readonly AuthorizationDetails[],
): readonly string[] {
  return Array.from(new Set(details.flatMap((item) => [...item.actions])))
}
