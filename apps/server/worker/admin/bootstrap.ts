// Seed / bootstrap(铁律 8、00 章 default org、02 章 Manager Roles、08 章 10/13.5/16.3):
// 从空 D1 到第一个租户可用。一次性幂等创建平台 instance + default organization +
// instance ES256 签名密钥(KEK 信封加密私钥)+ 初始 super admin user + instance_manager ManagerAssignment。
// 平台级操作:在 tenant 中间件之前注册(此刻无 instance,tenant 解析必 404),走独立管理路径不复用业务 API。
//
// 安全门控:D1 已有任何 instance -> 409 already_initialized(幂等,二次调用不重复创建);
// 可选 X-Bootstrap-Token 必须等长 constant-time 匹配 env.BOOTSTRAP_TOKEN(配置则强制,防公网滥用)。
//
// 隔离:除平台级 instances 表用 raw drizzle(无 tenant_id,独立管理路径)外,
// 所有租户实体(organizations/users/user_emails/memberships/manager_assignments)
// 一律走 @xid-kit/db 租户查询层注入 tenant_id(见 tenant-isolation rule)。

import { generateTenantSigningKey } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { drizzle } from 'drizzle-orm/d1'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { emailSchema, firstIssuePath, readJsonBody } from '../lib/validate'
import { decodeKek } from '../oidc/shared'

// KEK 版本(首版单 KEK,与 oidc/token 信封加密一致,见 signing-keys rule)。
const KEK_VERSION = 1

// 平台默认密码 / 会话 / token 策略(08 章 10.1 instances 默认 json;与 @xid-kit/types 的 DEFAULT_* 对齐,snake_case 落库)。
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

// 请求体:全部可选,缺省回退 env / 部署 Host。
const bootstrapBodySchema = v.object({
  // 平台主域(如 xid.dev);缺省取部署 Host 的 hostname。
  primaryDomain: v.optional(v.string()),
  // 解析模式:single_tenant(自托管默认)/ multi_tenant(xid.dev),缺省 single_tenant。
  mode: v.optional(v.picklist(['single_tenant', 'multi_tenant'])),
  instanceName: v.optional(v.string()),
  // 初始 default organization。
  defaultOrgName: v.optional(v.string()),
  defaultOrgSlug: v.optional(v.string()),
  // 初始 super admin 用户(承载 instance_manager ManagerAssignment)。
  // 必填:没有内置默认值,任何硬编码地址都会让部署方在自己的 instance 里创建归属他人的超管账号。
  adminEmail: emailSchema,
})
type BootstrapBody = v.InferOutput<typeof bootstrapBodySchema>

// 成功响应(绝不返回私钥 / 密文 / KEK)。
type BootstrapResult = {
  instanceId: string
  // default organization id(= tenantId)。
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

// 等长 constant-time 比较(避免 timing 泄露 token),长度不等直接 false。
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// slug 归一化:小写,非 [a-z0-9-] 折叠为 -,去首尾 -。
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

// 注册 bootstrap 路由。调用方(index.ts)在 tenant 中间件之前挂载到根 app。
export function registerBootstrapRoute(app: Hono<XidHonoEnv>): void {
  app.post('/admin/bootstrap', async (c) => handleBootstrap(c))
  app.post('/admin/bootstrap/repair', async (c) => handleBootstrapRepair(c))
}

async function handleBootstrap(c: Context<XidHonoEnv>): Promise<Response> {
  // 门控 1:可选 X-Bootstrap-Token(配置 env.BOOTSTRAP_TOKEN 则强制,防公网滥用)。
  const bootstrapGate = requireBootstrapToken(c, { allowMissingSecret: true })
  if (bootstrapGate) {
    return bootstrapGate
  }

  const db = drizzle(c.env.DB, { schema })

  // 门控 2:D1 已有任何 instance -> 已初始化,幂等返回 409(不重复创建)。
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

  // (1) instance(平台级,无 tenant_id,raw drizzle 独立管理路径)。
  const instanceId = `inst_${crypto.randomUUID()}`
  await db.insert(schema.instances).values({
    id: instanceId,
    name: body.instanceName ?? 'XID',
    primaryDomain,
    mode,
    defaultLocale: 'en',
    dataResidency: 'us',
    mfaPolicy: 'optional',
    passwordPolicy: DEFAULT_PASSWORD_POLICY,
    sessionPolicy: DEFAULT_SESSION_POLICY,
    tokenPolicy: DEFAULT_TOKEN_POLICY,
    status: 'active',
  })

  // (2) default organization(顶层 org;tenant_id = 自身 id)。
  const defaultOrgId = `org_${crypto.randomUUID()}`
  const defaultSlug = normalizeSlug(body.defaultOrgSlug ?? 'default')
  await insertTopOrg(c, {
    instanceId,
    id: defaultOrgId,
    slug: defaultSlug,
    name: body.defaultOrgName ?? 'Default Organization',
  })

  // (3) instance ES256 签名密钥:KEK 信封加密私钥,私钥明文不落库(见 signing-keys rule)。
  // (4) 初始 super admin user + instance_manager ManagerAssignment(平台层,scope=instance,不进业务 token)。
  // user / assignment 归属 default organization。
  const defaultDb = createTenantDb(c.env.DB, tenantCtxFor(defaultOrgId))
  const instanceKid = await createInstanceSigningKey(c, instanceId)

  const adminUserId = `user_${crypto.randomUUID()}`
  const adminEmail = body.adminEmail.trim().toLowerCase()
  const adminEmailId = `eml_${crypto.randomUUID()}`
  await defaultDb.users.insert({
    id: adminUserId,
    tenantId: defaultOrgId,
    primaryEmailId: adminEmailId,
    displayName: 'Instance Manager',
    provisionedBy: 'bootstrap',
    status: 'active',
    isNewUser: false,
  })
  await defaultDb.userEmails.insert({
    id: adminEmailId,
    tenantId: defaultOrgId,
    userId: adminUserId,
    email: adminEmail,
    verified: true,
    verificationStatus: 'verified',
    isPrimary: true,
    verifiedAt: new Date(),
  })
  await defaultDb.memberships.insert({
    id: `mem_${crypto.randomUUID()}`,
    tenantId: defaultOrgId,
    orgId: defaultOrgId,
    userId: adminUserId,
    role: 'owner',
    membershipType: 'member',
    status: 'active',
    isManaged: false,
    joinedAt: new Date(),
  })
  // Instance Manager 角色 = ManagerAssignment(平台管理层,与业务 RBAC 分离,见 02 章 3、08 章 13.5）。
  await defaultDb.managerAssignments.insert({
    id: `mgr_${crypto.randomUUID()}`,
    tenantId: defaultOrgId,
    userId: adminUserId,
    managerRole: 'instance_manager',
    scopeType: 'instance',
    scopeId: null,
  })

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

// 解析请求体:坏 JSON / 形状失败 -> 自家 ErrorBody validation_failed 400
// (bootstrap 不经 AppError/XidAPIError,错误契约是 {code,message})。
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

// 顶层 org 插入:tenant_id = 自身 id(租户隔离根,见 08 章 10.2)。走租户查询层注入 tenant_id。
async function insertTopOrg(
  c: Context<XidHonoEnv>,
  input: { instanceId: string; id: string; slug: string; name: string },
): Promise<void> {
  const db = createTenantDb(c.env.DB, tenantCtxFor(input.id))
  // 顶层 org 的 tenant_id = 自身 id(租户隔离根,见 08 章 10.2)。
  await db.organizations.insert({
    id: input.id,
    tenantId: input.id,
    instanceId: input.instanceId,
    parentOrgId: null,
    slug: input.slug,
    name: input.name,
    privateMetadata: defaultOrgMetadata(),
    status: 'active',
  })
}

async function createInstanceSigningKey(
  c: Context<XidHonoEnv>,
  instanceId: string,
): Promise<string> {
  const kid = `key_${crypto.randomUUID()}`
  const kekRaw = decodeKek(c.env.KEK)
  const { material } = await generateTenantSigningKey({
    kid,
    kekRaw,
    kekVersion: KEK_VERSION,
    alg: 'ES256',
    status: 'active',
  })
  kekRaw.fill(0)
  const enc = material.encryptedPrivateKey
  await c.env.DB.prepare(
    `INSERT INTO instance_signing_keys (
       id, instance_id, kid, alg, public_key_jwk, private_key_iv, private_key_ciphertext,
       private_key_tag, kek_version, status, activated_at, retire_after, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      `sk_${crypto.randomUUID()}`,
      instanceId,
      material.kid,
      material.alg,
      JSON.stringify(material.publicKeyJwk),
      toBuffer(enc.iv),
      toBuffer(enc.ciphertext),
      toBuffer(enc.tag),
      enc.kekVersion,
      material.status,
      Date.now(),
      Date.now(),
      Date.now(),
    )
    .run()
  return material.kid
}

// 构造最小 TenantContext(只为驱动租户查询层注入 tenant_id;签名密钥此刻为空,bootstrap 不读)。
function tenantCtxFor(tenantId: string): TenantContext {
  return {
    tenantId,
    issuer: '',
    rpId: '',
    signingKeys: { activeKid: '', defaultAlg: 'ES256', keys: [] },
    policy: {},
  }
}

// Uint8Array -> Buffer(drizzle blob buffer mode 落库;envelope 三 blob,见 08 章 16.3)。
// 与 passkey-helpers 同款 Buffer.from(nodejs_compat 提供 Buffer)。
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes)
}
