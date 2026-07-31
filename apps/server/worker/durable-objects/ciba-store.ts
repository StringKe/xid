// CibaStore:一个 auth_req_id 对应一个 DO,原子管理 CIBA 状态与 token 签发 lease。
// token polling、签发 reservation、finalize/abort 都在 storage transaction 内完成,避免并发重复签发。

import { CIBA_ISSUANCE_RESERVATION_TTL_SEC } from '../lib/ttl'

export type CibaRecord = {
  clientId: string
  scope: string
  loginHint: string
  status: 'pending' | 'approved' | 'issuing' | 'denied' | 'consumed'
  userId?: string
  expiresAt: number
  lastPollAt?: number
  reservationId?: string
  reservationExpiresAt?: number
  finalizedReservationId?: string
}

const RECORD_KEY = 'record'
const ALARM_LAG_MS = 60 * 1000

type MutationOutcome =
  | { status: 200; record?: CibaRecord; reservationId?: string }
  | { status: 202 }
  | { status: 400; code: 'invalid_request' }
  | { status: 403; code: 'access_denied' }
  | { status: 404; code: 'not_found' }
  | { status: 409; code: 'already_exists' | 'invalid_state' | 'consumed' }
  | { status: 410; code: 'expired' }
  | { status: 429; code: 'slow_down' }

export class CibaStore {
  private readonly ctx: DurableObjectState

  constructor(state: DurableObjectState) {
    this.ctx = state
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method !== 'POST') return new Response('Not Found', { status: 404 })
    if (path === '/create') return this.handleCreate(request)
    if (path === '/read') return this.handleRead()
    if (path === '/approve') return this.handleApprove(request)
    if (path === '/deny') return this.handleDeny()
    if (path === '/poll') return this.handlePoll(request)
    if (path === '/finalize') return this.handleReservationMutation(request, 'consumed')
    if (path === '/abort') return this.handleReservationMutation(request, 'approved')
    return new Response('Not Found', { status: 404 })
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<CibaRecord>(RECORD_KEY)
    if (record && record.expiresAt * 1000 <= Date.now()) {
      await this.ctx.storage.delete(RECORD_KEY)
      return
    }
    if (record) await this.ctx.storage.setAlarm(record.expiresAt * 1000 + ALARM_LAG_MS)
  }

  private async handleCreate(request: Request): Promise<Response> {
    const body = await readObject(request)
    const record = body ? parseCreateRecord(body) : null
    if (!record) return outcomeResponse({ status: 400, code: 'invalid_request' })

    const outcome = await this.ctx.storage.transaction<MutationOutcome>(async (txn) => {
      const existing = await txn.get<CibaRecord>(RECORD_KEY)
      if (existing) return { status: 409, code: 'already_exists' }
      await txn.put(RECORD_KEY, record)
      return { status: 200 }
    })
    if (outcome.status === 200) {
      await this.ctx.storage.setAlarm(record.expiresAt * 1000 + ALARM_LAG_MS)
      return new Response(null, { status: 201 })
    }
    return outcomeResponse(outcome)
  }

  private async handleRead(): Promise<Response> {
    const record = await this.ctx.storage.get<CibaRecord>(RECORD_KEY)
    if (!record) return outcomeResponse({ status: 404, code: 'not_found' })
    if (isExpired(record, Date.now() / 1000)) {
      await this.ctx.storage.delete(RECORD_KEY)
      return outcomeResponse({ status: 410, code: 'expired' })
    }
    return outcomeResponse({ status: 200, record })
  }

  private async handleApprove(request: Request): Promise<Response> {
    const body = await readObject(request)
    const userId = body?.['userId']
    if (typeof userId !== 'string' || userId.length === 0) {
      return outcomeResponse({ status: 400, code: 'invalid_request' })
    }

    const outcome = await this.ctx.storage.transaction<MutationOutcome>(async (txn) => {
      const record = await txn.get<CibaRecord>(RECORD_KEY)
      if (!record) return { status: 404, code: 'not_found' }
      if (isExpired(record, Date.now() / 1000)) {
        await txn.delete(RECORD_KEY)
        return { status: 410, code: 'expired' }
      }
      if (record.status !== 'pending') return { status: 409, code: 'invalid_state' }
      const approved: CibaRecord = { ...record, status: 'approved', userId }
      await txn.put(RECORD_KEY, approved)
      return { status: 200 }
    })
    return outcomeResponse(outcome)
  }

  private async handleDeny(): Promise<Response> {
    const outcome = await this.ctx.storage.transaction<MutationOutcome>(async (txn) => {
      const record = await txn.get<CibaRecord>(RECORD_KEY)
      if (!record) return { status: 404, code: 'not_found' }
      if (isExpired(record, Date.now() / 1000)) {
        await txn.delete(RECORD_KEY)
        return { status: 410, code: 'expired' }
      }
      if (record.status !== 'pending') return { status: 409, code: 'invalid_state' }
      await txn.put(RECORD_KEY, { ...record, status: 'denied' } satisfies CibaRecord)
      return { status: 200 }
    })
    return outcomeResponse(outcome)
  }

  private async handlePoll(request: Request): Promise<Response> {
    const body = await readObject(request)
    const clientId = body?.['clientId']
    const nowSec = body?.['nowSec']
    const intervalSec = body?.['intervalSec']
    const reservationTtlSec = body?.['reservationTtlSec'] ?? CIBA_ISSUANCE_RESERVATION_TTL_SEC
    if (
      typeof clientId !== 'string' ||
      clientId.length === 0 ||
      typeof nowSec !== 'number' ||
      !Number.isFinite(nowSec) ||
      typeof intervalSec !== 'number' ||
      !Number.isFinite(intervalSec) ||
      intervalSec <= 0 ||
      typeof reservationTtlSec !== 'number' ||
      !Number.isFinite(reservationTtlSec) ||
      reservationTtlSec <= 0
    ) {
      return outcomeResponse({ status: 400, code: 'invalid_request' })
    }

    const outcome = await this.ctx.storage.transaction<MutationOutcome>(async (txn) => {
      const record = await txn.get<CibaRecord>(RECORD_KEY)
      if (!record || record.clientId !== clientId) return { status: 404, code: 'not_found' }
      if (isExpired(record, nowSec)) {
        await txn.delete(RECORD_KEY)
        return { status: 410, code: 'expired' }
      }
      if (record.status === 'denied') return { status: 403, code: 'access_denied' }
      if (record.status === 'consumed') return { status: 409, code: 'consumed' }
      if (record.status === 'pending') {
        if (record.lastPollAt !== undefined && nowSec - record.lastPollAt < intervalSec) {
          return { status: 429, code: 'slow_down' }
        }
        await txn.put(RECORD_KEY, { ...record, lastPollAt: nowSec })
        return { status: 202 }
      }
      if (
        record.status === 'issuing' &&
        (record.reservationExpiresAt === undefined || record.reservationExpiresAt > nowSec)
      ) {
        return { status: 202 }
      }
      if (!record.userId) return { status: 409, code: 'invalid_state' }

      // approved 或过期的 issuing lease -> 新 reservation。reservationId 是 fencing token,
      // 旧签发者即使随后恢复也不能 finalize 新 lease。
      const approved = clearReservation(record, 'approved')
      const reservationId = crypto.randomUUID()
      await txn.put(RECORD_KEY, {
        ...approved,
        status: 'issuing',
        reservationId,
        reservationExpiresAt: nowSec + reservationTtlSec,
      } satisfies CibaRecord)
      return { status: 200, record: approved, reservationId }
    })
    return outcomeResponse(outcome)
  }

  private async handleReservationMutation(
    request: Request,
    nextStatus: 'approved' | 'consumed',
  ): Promise<Response> {
    const body = await readObject(request)
    const clientId = body?.['clientId']
    const reservationId = body?.['reservationId']
    if (
      typeof clientId !== 'string' ||
      clientId.length === 0 ||
      typeof reservationId !== 'string' ||
      reservationId.length === 0
    ) {
      return outcomeResponse({ status: 400, code: 'invalid_request' })
    }

    const outcome = await this.ctx.storage.transaction<MutationOutcome>(async (txn) => {
      const record = await txn.get<CibaRecord>(RECORD_KEY)
      if (!record || record.clientId !== clientId) return { status: 404, code: 'not_found' }
      if (isExpired(record, Date.now() / 1000)) {
        await txn.delete(RECORD_KEY)
        return { status: 410, code: 'expired' }
      }
      if (
        nextStatus === 'consumed' &&
        record.status === 'consumed' &&
        record.finalizedReservationId === reservationId
      ) {
        return { status: 200 }
      }
      if (record.status !== 'issuing' || record.reservationId !== reservationId) {
        return {
          status: 409,
          code: record.status === 'consumed' ? 'consumed' : 'invalid_state',
        }
      }
      const next = clearReservation(record, nextStatus)
      if (nextStatus === 'consumed') next.finalizedReservationId = reservationId
      await txn.put(RECORD_KEY, next)
      return { status: 200 }
    })
    return outcomeResponse(outcome)
  }
}

function clearReservation(record: CibaRecord, status: 'approved' | 'consumed'): CibaRecord {
  const next: CibaRecord = { ...record, status }
  delete next.reservationId
  delete next.reservationExpiresAt
  return next
}

function isExpired(record: CibaRecord, nowSec: number): boolean {
  return record.expiresAt <= nowSec
}

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json()
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function parseCreateRecord(body: Record<string, unknown>): CibaRecord | null {
  const clientId = body['clientId']
  const scope = body['scope']
  const loginHint = body['loginHint']
  const expiresAt = body['expiresAt']
  if (
    typeof clientId !== 'string' ||
    clientId.length === 0 ||
    typeof scope !== 'string' ||
    scope.length === 0 ||
    typeof loginHint !== 'string' ||
    loginHint.length === 0 ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() / 1000
  ) {
    return null
  }
  return { clientId, scope, loginHint, expiresAt, status: 'pending' }
}

function outcomeResponse(outcome: MutationOutcome): Response {
  if (outcome.status === 200) {
    const body =
      outcome.record || outcome.reservationId
        ? JSON.stringify({
            ...(outcome.record ? { record: outcome.record } : {}),
            ...(outcome.reservationId ? { reservationId: outcome.reservationId } : {}),
          })
        : null
    return new Response(body, {
      status: 200,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
    })
  }
  if (outcome.status === 202) return new Response(null, { status: 202 })
  return new Response(JSON.stringify({ code: outcome.code }), {
    status: outcome.status,
    headers: { 'Content-Type': 'application/json' },
  })
}
