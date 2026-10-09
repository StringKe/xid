// SessionHandoffDO:一个随机 grant id 对应一次跨主机会话交接(租户子域 <-> 实例根域,双向)。
// __Host- 会话 cookie 不能跨主机,passkey 仪式只在组织 rpId 主机进行,由这里把会话一次性交给目标主机。
// 会话状态原样携带:待 MFA 的会话交接后仍待 MFA,不会被提升。
// 只存 secret 与目标主机 state 的 SHA-256;消费在存储事务里比对后删除,并发消费只有一个成功。

import { SESSION_HANDOFF_TTL_MS } from '../lib/ttl'

const ALARM_LAG_MS = 30 * 1000
const RECORD_KEY = 'grant'

export const HANDOFF_SESSION_STATUSES = ['active', 'pending_mfa', 'pending_mfa_setup'] as const
export type HandoffSessionStatus = (typeof HANDOFF_SESSION_STATUSES)[number]

export type SessionHandoffRecord = {
  secretHash: string
  stateHash: string
  tenantId: string
  instanceId: string
  targetOrigin: string
  userId: string
  continuePath: string
  authenticatedAt: number
  sessionStatus: HandoffSessionStatus
  acr: string | null
  amr: string[] | null
  aal: number | null
  rememberMe: boolean
  issuedAt: number
  expiresAt: number
}

export type ConsumedSessionHandoff = Omit<SessionHandoffRecord, 'secretHash' | 'stateHash'>

type CreateInput = Omit<SessionHandoffRecord, 'issuedAt' | 'expiresAt'> & { ttlMs: number }

type ConsumeInput = {
  secretHash: string
  stateHash: string
  tenantId: string
  instanceId: string
  targetOrigin: string
}

const CREATE_STRING_FIELDS = [
  'tenantId',
  'instanceId',
  'targetOrigin',
  'userId',
  'continuePath',
] as const

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSessionSnapshot(value: Record<string, unknown>): boolean {
  const amr = value['amr']
  return (
    (HANDOFF_SESSION_STATUSES as readonly unknown[]).includes(value['sessionStatus']) &&
    (value['acr'] === null || typeof value['acr'] === 'string') &&
    (amr === null || (Array.isArray(amr) && amr.every((entry) => typeof entry === 'string'))) &&
    (value['aal'] === null || isFiniteNumber(value['aal'])) &&
    typeof value['rememberMe'] === 'boolean'
  )
}

function parseCreateInput(value: unknown): CreateInput | null {
  if (!isRecord(value)) return null
  if (!isSha256Hex(value['secretHash']) || !isSha256Hex(value['stateHash'])) return null
  if (!CREATE_STRING_FIELDS.every((field) => isNonEmptyString(value[field]))) return null
  const ttlMs = value['ttlMs']
  if (!isFiniteNumber(ttlMs) || ttlMs <= 0 || ttlMs > SESSION_HANDOFF_TTL_MS) return null
  if (!isFiniteNumber(value['authenticatedAt']) || !isSessionSnapshot(value)) return null
  return value as CreateInput
}

function parseConsumeInput(value: unknown): ConsumeInput | null {
  if (!isRecord(value)) return null
  if (!isSha256Hex(value['secretHash']) || !isSha256Hex(value['stateHash'])) return null
  const fields = ['tenantId', 'instanceId', 'targetOrigin'] as const
  if (!fields.every((field) => isNonEmptyString(value[field]))) return null
  return value as ConsumeInput
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function matches(record: SessionHandoffRecord, input: ConsumeInput): boolean {
  const secretOk = constantTimeEqualHash(record.secretHash, input.secretHash)
  const stateOk = constantTimeEqualHash(record.stateHash, input.stateHash)
  return (
    secretOk &&
    stateOk &&
    record.tenantId === input.tenantId &&
    record.instanceId === input.instanceId &&
    record.targetOrigin === input.targetOrigin
  )
}

function withoutSecrets(record: SessionHandoffRecord): ConsumedSessionHandoff {
  const { secretHash: _secretHash, stateHash: _stateHash, ...consumed } = record
  return consumed
}

export class SessionHandoffDO {
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
    const record = await this.ctx.storage.get<SessionHandoffRecord>(RECORD_KEY)
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
    const { ttlMs, ...fields } = input
    const record: SessionHandoffRecord = { ...fields, issuedAt: now, expiresAt: now + ttlMs }
    const created = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<SessionHandoffRecord>(RECORD_KEY)
      if (existing && existing.expiresAt > now) return false
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
    const consumed = await this.ctx.storage.transaction<ConsumedSessionHandoff | 'expired' | null>(
      async (txn) => {
        const record = await txn.get<SessionHandoffRecord>(RECORD_KEY)
        if (!record) return null
        if (record.expiresAt <= now) {
          await txn.delete(RECORD_KEY)
          return 'expired'
        }
        if (!matches(record, input)) return null
        await txn.delete(RECORD_KEY)
        return withoutSecrets(record)
      },
    )
    if (consumed === 'expired') return json(410, { code: 'grant_invalid' })
    if (!consumed) return json(404, { code: 'grant_invalid' })
    await this.ctx.storage.deleteAlarm()
    return json(200, { grant: consumed })
  }
}
