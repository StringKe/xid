// ImpersonationGrantDO: one random grant id maps to one short-lived, consume-once handoff.
// The raw bearer secret never enters Durable Object storage. Core hashes it before create/consume,
// and the object serializes the compare-and-delete transition so concurrent consumers cannot both
// establish a session.

export const IMPERSONATION_GRANT_TTL_MS = 2 * 60 * 1000
const ALARM_LAG_MS = 30 * 1000
const RECORD_KEY = 'grant'

export type ImpersonationGrantRecord = {
  secretHash: string
  targetTenantId: string
  targetOrganizationId: string
  targetOrganizationSlug: string
  targetUserId: string
  targetInstanceId: string
  targetOrigin: string
  impersonatorUserId: string
  actorIp: string | null
  issuedAt: number
  expiresAt: number
}

export type ConsumedImpersonationGrant = Omit<ImpersonationGrantRecord, 'secretHash'>

type CreateInput = Omit<ImpersonationGrantRecord, 'issuedAt' | 'expiresAt'> & {
  ttlMs: number
}

type ConsumeInput = {
  secretHash: string
  targetTenantId: string
  targetInstanceId: string
  targetOrigin: string
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status })
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function constantTimeEqualHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let different = 0
  for (let index = 0; index < a.length; index++) {
    different |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return different === 0
}

function parseCreateInput(value: unknown): CreateInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    !isSha256Hex(input['secretHash']) ||
    !isNonEmptyString(input['targetTenantId']) ||
    !isNonEmptyString(input['targetOrganizationId']) ||
    !isNonEmptyString(input['targetOrganizationSlug']) ||
    !isNonEmptyString(input['targetUserId']) ||
    !isNonEmptyString(input['targetInstanceId']) ||
    !isNonEmptyString(input['targetOrigin']) ||
    !isNonEmptyString(input['impersonatorUserId']) ||
    (input['actorIp'] !== null && typeof input['actorIp'] !== 'string') ||
    typeof input['ttlMs'] !== 'number' ||
    !Number.isFinite(input['ttlMs']) ||
    input['ttlMs'] <= 0 ||
    input['ttlMs'] > IMPERSONATION_GRANT_TTL_MS
  ) {
    return null
  }
  return input as CreateInput
}

function parseConsumeInput(value: unknown): ConsumeInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    !isSha256Hex(input['secretHash']) ||
    !isNonEmptyString(input['targetTenantId']) ||
    !isNonEmptyString(input['targetInstanceId']) ||
    !isNonEmptyString(input['targetOrigin'])
  ) {
    return null
  }
  return input as ConsumeInput
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function withoutSecret(record: ImpersonationGrantRecord): ConsumedImpersonationGrant {
  const { secretHash: _secretHash, ...consumed } = record
  return consumed
}

export class ImpersonationGrantDO {
  private readonly ctx: DurableObjectState

  constructor(state: DurableObjectState) {
    this.ctx = state
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Not Found', { status: 404 })
    const path = new URL(request.url).pathname
    if (path === '/create') return this.create(request)
    if (path === '/consume') return this.consume(request)
    return new Response('Not Found', { status: 404 })
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<ImpersonationGrantRecord>(RECORD_KEY)
    if (!record || record.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(RECORD_KEY)
      return
    }
    await this.ctx.storage.setAlarm(record.expiresAt + ALARM_LAG_MS)
  }

  private async create(request: Request): Promise<Response> {
    const input = parseCreateInput(await readJson(request))
    if (!input) return json(400, { code: 'invalid_request' })

    const now = Date.now()
    const record: ImpersonationGrantRecord = {
      secretHash: input.secretHash,
      targetTenantId: input.targetTenantId,
      targetOrganizationId: input.targetOrganizationId,
      targetOrganizationSlug: input.targetOrganizationSlug,
      targetUserId: input.targetUserId,
      targetInstanceId: input.targetInstanceId,
      targetOrigin: input.targetOrigin,
      impersonatorUserId: input.impersonatorUserId,
      actorIp: input.actorIp,
      issuedAt: now,
      expiresAt: now + input.ttlMs,
    }
    const created = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<ImpersonationGrantRecord>(RECORD_KEY)
      if (existing && existing.expiresAt > now) return false
      if (existing) await txn.delete(RECORD_KEY)
      await txn.put(RECORD_KEY, record)
      return true
    })
    if (!created) return json(409, { code: 'already_exists' })

    await this.ctx.storage.setAlarm(record.expiresAt + ALARM_LAG_MS)
    return json(201, { expiresAt: record.expiresAt })
  }

  private async consume(request: Request): Promise<Response> {
    const input = parseConsumeInput(await readJson(request))
    if (!input) return json(400, { code: 'invalid_request' })

    const now = Date.now()
    const consumed = await this.ctx.storage.transaction<
      ConsumedImpersonationGrant | 'expired' | null
    >(async (txn) => {
      const record = await txn.get<ImpersonationGrantRecord>(RECORD_KEY)
      if (!record) return null
      if (record.expiresAt <= now) {
        await txn.delete(RECORD_KEY)
        return 'expired'
      }
      if (
        !constantTimeEqualHash(record.secretHash, input.secretHash) ||
        record.targetTenantId !== input.targetTenantId ||
        record.targetInstanceId !== input.targetInstanceId ||
        record.targetOrigin !== input.targetOrigin
      ) {
        return null
      }
      await txn.delete(RECORD_KEY)
      return withoutSecret(record)
    })

    if (consumed === 'expired') return json(410, { code: 'grant_invalid' })
    if (!consumed) return json(404, { code: 'grant_invalid' })
    await this.ctx.storage.deleteAlarm()
    return json(200, { grant: consumed })
  }
}
