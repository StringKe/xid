// 空 D1 一次性幂等初始化:instance + default org + ES256 签名密钥 + super admin + instance_manager。
// 须在 tenant 中间件前;已有 instance 返 409;可选 BOOTSTRAP_TOKEN 等长 constant-time 校验。
// 全部 relational row 同一 D1 batch,显式同一 tenant_id。

import { generateTenantSigningKey } from '@xid-kit/crypto'
import { schema } from '@xid-kit/db'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { drizzle } from 'drizzle-orm/d1'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { createPersistedId } from '../lib/persisted-id'
import { emailSchema, firstIssuePath, readJsonBody } from '../lib/validate'
import { decodeKek } from '../oidc/shared'
import { PLAN_DEFAULTS } from '../platform/plans'

const KEK_VERSION = 1

// instances 默认策略 json(与 @xid-kit/types DEFAULT_* 对齐,snake_case 落库)。
const DEFAULT_PASSWORD_POLICY = {
  min_length: 12,
  max_length: 128,
  require_breach_check: true,
  history_count: 5,
}
const DEFAULT_SESSION_POLICY = {
  idle_timeout_min: 4320,
  absolute_timeout_days: 30,
}
const DEFAULT_TOKEN_POLICY = {
  access_token_ttl_sec: 3600,
  session_token_ttl_sec: 60,
  refresh_idle_timeout_days: 30,
  refresh_absolute_timeout_days: 7,
}

// 字段全可选(缺省 env/Host);adminEmail 必填且无内置默认,防部署方误建归属他人的超管。
const bootstrapBodySchema = v.object({
  primaryDomain: v.optional(v.string()),
  mode: v.optional(v.picklist(['single_tenant', 'multi_tenant'])),
  instanceName: v.optional(v.string()),
  defaultOrgName: v.optional(v.string()),
  defaultOrgSlug: v.optional(v.string()),
  adminEmail: emailSchema,
})
type BootstrapBody = v.InferOutput<typeof bootstrapBodySchema>

// 成功响应绝不含私钥/密文/KEK。
type BootstrapResult = {
  instanceId: string
  defaultOrgId: string
  orgId: string
  tenantId: string
  issuer: string
  kid: string
}

type BootstrapRepairResult = {
  repaired: Array<{ instanceId: string; kid: string }>
  repairedPrimaryEmailUsers: number
}

type ErrorBody = { code: string; message: string }

function hostnameOf(c: Context<XidHonoEnv>): string | undefined {
  const host = c.req.header('host')
  if (!host) return undefined
  const i = host.indexOf(':')
  return (i === -1 ? host : host.slice(0, i)).toLowerCase()
}

// 等长 constant-time;长度不等直接 false,防 timing 泄露。
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function json(c: Context<XidHonoEnv>, body: unknown, status: number): Response {
  return c.body(JSON.stringify(body), status as 200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
}

function defaultOrgMetadata(): Record<string, unknown> {
  return { hostedAuth: DEFAULT_HOSTED_AUTH_POLICY }
}

export function registerBootstrapRoute(app: Hono<XidHonoEnv>): void {
  app.post('/admin/bootstrap', async (c) => handleBootstrap(c))
  app.post('/admin/bootstrap/repair', async (c) => handleBootstrapRepair(c))
}

async function handleBootstrap(c: Context<XidHonoEnv>): Promise<Response> {
  // 可选 X-Bootstrap-Token;配置 BOOTSTRAP_TOKEN 则强制。
  const bootstrapGate = requireBootstrapToken(c, { allowMissingSecret: true })
  if (bootstrapGate) {
    return bootstrapGate
  }

  const db = drizzle(c.env.DB, { schema })

  // 已有 instance -> 409 幂等,不重复创建。
  const existing = await db.select().from(schema.instances).limit(1)
  if (existing[0]) {
    const body: ErrorBody = {
      code: 'already_initialized',
      message: 'Instance already initialized.',
    }
    return json(c, body, 409)
  }

  const parsedBody = await readBody(c)
  if (parsedBody instanceof Response) return parsedBody
  const body = parsedBody

  const primaryDomain = (body.primaryDomain ?? hostnameOf(c) ?? 'localhost').toLowerCase()
  const mode = body.mode ?? 'single_tenant'

  // 先内存生成 ids 与信封密钥,尚未落库。
  const instanceId = createPersistedId('instance')
  const defaultOrgId = createPersistedId('organization')
  const defaultSlug = normalizeSlug(body.defaultOrgSlug ?? 'default')
  const adminUserId = createPersistedId('user')
  const adminEmail = body.adminEmail.trim().toLowerCase()
  const adminEmailId = `eml_${crypto.randomUUID()}`
  const signingKey = await prepareInstanceSigningKey(c)
  const instanceKid = signingKey.material.kid
  const now = Date.now()
  const seatLimit = PLAN_DEFAULTS.free.seatLimit

  // 整批事务:instance 不可先于其余资源单独提交,否则重试误判 already_initialized。
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO instances (
         id, name, primary_domain, mode, default_locale, data_residency, mfa_policy,
         password_policy, session_policy, token_policy, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'en', 'us', 'optional', ?, ?, ?, 'active', ?, ?)`,
    ).bind(
      instanceId,
      body.instanceName ?? 'XID',
      primaryDomain,
      mode,
      JSON.stringify(DEFAULT_PASSWORD_POLICY),
      JSON.stringify(DEFAULT_SESSION_POLICY),
      JSON.stringify(DEFAULT_TOKEN_POLICY),
      now,
      now,
    ),
    topOrgStatement(c.env.DB, {
      instanceId,
      id: defaultOrgId,
      slug: defaultSlug,
      name: body.defaultOrgName ?? 'Default Organization',
      seatLimit,
      now,
    }),
    c.env.DB.prepare(
      `INSERT INTO organization_quotas (
         tenant_id, quota_key, "limit", enforcement, updated_by, created_at, updated_at
       ) VALUES (?, 'seats', ?, 'block_creation', NULL, ?, ?)`,
    ).bind(defaultOrgId, seatLimit, now, now),
    instanceSigningKeyStatement(c.env.DB, instanceId, signingKey),
    c.env.DB.prepare(
      `INSERT INTO users (
         id, tenant_id, primary_email_id, display_name, provisioned_by, status,
         is_new_user, created_at, updated_at
       ) VALUES (?, ?, ?, 'Instance Manager', 'bootstrap', 'active', 0, ?, ?)`,
    ).bind(adminUserId, defaultOrgId, adminEmailId, now, now),
    c.env.DB.prepare(
      `INSERT INTO user_emails (
         id, tenant_id, user_id, email, verified, verification_status, is_primary,
         verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'verified', 1, ?, ?, ?)`,
    ).bind(adminEmailId, defaultOrgId, adminUserId, adminEmail, now, now, now),
    c.env.DB.prepare(
      `INSERT INTO memberships (
         id, tenant_id, org_id, user_id, role, membership_type, status, is_managed,
         joined_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'owner', 'member', 'active', 0, ?, ?, ?)`,
    ).bind(createPersistedId('membership'), defaultOrgId, defaultOrgId, adminUserId, now, now, now),
    c.env.DB.prepare(
      `INSERT INTO manager_assignments (
         id, tenant_id, user_id, manager_role, scope_type, scope_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'instance_manager', 'instance', NULL, ?, ?)`,
    ).bind(createPersistedId('managerAssignment'), defaultOrgId, adminUserId, now, now),
  ])

  const result: BootstrapResult = {
    instanceId,
    defaultOrgId,
    orgId: defaultOrgId,
    tenantId: defaultOrgId,
    issuer: `https://${primaryDomain}`,
    kid: instanceKid,
  }
  return json(c, result, 201)
}

async function handleBootstrapRepair(c: Context<XidHonoEnv>): Promise<Response> {
  const bootstrapGate = requireBootstrapToken(c, { allowMissingSecret: false })
  if (bootstrapGate) {
    return bootstrapGate
  }

  const rows = await c.env.DB.prepare(
    `SELECT inst.id AS instance_id
       FROM instances inst
       WHERE inst.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM instance_signing_keys signing_key
           WHERE signing_key.instance_id = inst.id
             AND signing_key.status IN ('active', 'next', 'retiring')
         )
       ORDER BY inst.id
       LIMIT 20`,
  ).all<{ instance_id: string }>()

  const repaired: BootstrapRepairResult['repaired'] = []
  for (const row of rows.results) {
    const kid = await createInstanceSigningKey(c, row.instance_id)
    repaired.push({ instanceId: row.instance_id, kid })
  }
  const repairedPrimaryEmailUsers = await repairMissingPrimaryEmailIds(c)

  return json(c, { repaired, repairedPrimaryEmailUsers }, 200)
}

async function repairMissingPrimaryEmailIds(c: Context<XidHonoEnv>): Promise<number> {
  const result = await c.env.DB.prepare(
    `UPDATE users
       SET primary_email_id = (
         SELECT user_emails.id
         FROM user_emails
         WHERE user_emails.tenant_id = users.tenant_id
           AND user_emails.user_id = users.id
           AND user_emails.is_primary = 1
         ORDER BY user_emails.created_at ASC
         LIMIT 1
       ),
       updated_at = ?
     WHERE primary_email_id IS NULL
       AND EXISTS (
         SELECT 1
         FROM user_emails
         WHERE user_emails.tenant_id = users.tenant_id
           AND user_emails.user_id = users.id
           AND user_emails.is_primary = 1
       )`,
  )
    .bind(Date.now())
    .run()
  return result.meta.changes ?? 0
}

function requireBootstrapToken(
  c: Context<XidHonoEnv>,
  options: { allowMissingSecret: boolean },
): Response | undefined {
  const required = c.env.BOOTSTRAP_TOKEN
  if (required === undefined || required === '') {
    // 生产/预发必须显式配置 token:缺 secret 是部署 misconfiguration,不能静默放行公网 bootstrap。
    const envName = c.env.ENVIRONMENT?.toLowerCase()
    if (envName === 'production' || envName === 'staging') {
      const body: ErrorBody = {
        code: 'bootstrap_token_required',
        message: 'BOOTSTRAP_TOKEN secret must be configured in production/staging.',
      }
      return json(c, body, 503)
    }
    if (options.allowMissingSecret) return undefined
    const body: ErrorBody = {
      code: 'bootstrap_token_required',
      message: 'Bootstrap token secret is required.',
    }
    return json(c, body, 401)
  }
  const provided = c.req.header('x-bootstrap-token') ?? ''
  if (!timingSafeEqual(provided, required)) {
    const body: ErrorBody = { code: 'unauthorized', message: 'Invalid bootstrap token.' }
    return json(c, body, 401)
  }
  return undefined
}

// bootstrap 错误契约是 {code,message},不经 AppError。
async function readBody(c: Context<XidHonoEnv>): Promise<BootstrapBody | Response> {
  const json = await readJsonBody(c)
  if (!json.ok) return validationFailedBody(c, 'body')
  const result = v.safeParse(bootstrapBodySchema, json.value)
  if (!result.success) return validationFailedBody(c, firstIssuePath(result.issues))
  return result.output
}

function validationFailedBody(c: Context<XidHonoEnv>, paramName: string): Response {
  const body: ErrorBody = {
    code: 'validation_failed',
    message: `Invalid request body: ${paramName}.`,
  }
  return json(c, body, 400)
}

// 顶层 org 的 tenant_id = 自身 id(租户隔离根,见 08 章 10.2)。
function topOrgStatement(
  db: D1Database,
  input: {
    instanceId: string
    id: string
    slug: string
    name: string
    seatLimit: number | null
    now: number
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO organizations (
         id, tenant_id, instance_id, parent_org_id, slug, name,
         public_metadata, private_metadata, seat_limit, seat_used,
         enrollment_mode, allow_org_self_service, status, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?, '{}', ?, ?, 0, 'invite_required', 1, 'active', ?, ?)`,
    )
    .bind(
      input.id,
      input.id,
      input.instanceId,
      input.slug,
      input.name,
      JSON.stringify(defaultOrgMetadata()),
      input.seatLimit,
      input.now,
      input.now,
    )
}

type PreparedInstanceSigningKey = {
  rowId: string
  material: Awaited<ReturnType<typeof generateTenantSigningKey>>['material']
  now: number
}

async function prepareInstanceSigningKey(
  c: Context<XidHonoEnv>,
): Promise<PreparedInstanceSigningKey> {
  const kid = `key_${crypto.randomUUID()}`
  const kekRaw = decodeKek(c.env.KEK)
  try {
    const { material } = await generateTenantSigningKey({
      kid,
      kekRaw,
      kekVersion: KEK_VERSION,
      alg: 'ES256',
      status: 'active',
    })
    return { rowId: createPersistedId('signingKey'), material, now: Date.now() }
  } finally {
    kekRaw.fill(0)
  }
}

function instanceSigningKeyStatement(
  db: D1Database,
  instanceId: string,
  input: PreparedInstanceSigningKey,
): D1PreparedStatement {
  const enc = input.material.encryptedPrivateKey
  return db
    .prepare(
      `INSERT INTO instance_signing_keys (
       id, instance_id, kid, alg, public_key_jwk, private_key_iv, private_key_ciphertext,
       private_key_tag, kek_version, status, activated_at, retire_after, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      input.rowId,
      instanceId,
      input.material.kid,
      input.material.alg,
      JSON.stringify(input.material.publicKeyJwk),
      toBuffer(enc.iv),
      toBuffer(enc.ciphertext),
      toBuffer(enc.tag),
      enc.kekVersion,
      input.material.status,
      input.now,
      input.now,
      input.now,
    )
}

async function createInstanceSigningKey(
  c: Context<XidHonoEnv>,
  instanceId: string,
): Promise<string> {
  const signingKey = await prepareInstanceSigningKey(c)
  await instanceSigningKeyStatement(c.env.DB, instanceId, signingKey).run()
  return signingKey.material.kid
}

// Uint8Array -> Buffer(drizzle blob buffer mode 落库;envelope 三 blob,见 08 章 16.3)。
// 与 passkey-helpers 同款 Buffer.from(nodejs_compat 提供 Buffer)。
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes)
}
