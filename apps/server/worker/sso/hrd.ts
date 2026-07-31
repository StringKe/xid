// hrd.ts:Home Realm Discovery -- 邮箱域路由到对应 org 的 SsoConnection。
// 查询 organization_domains(verificationStatus=verified),匹配邮箱域名后返回 active SsoConnection。
// 铁律:
//   - 未验证域名不触发 SSO 路由(见 04 章 4)。
//   - 域名查询走租户查询层(自动注入 tenant_id),禁裸 SQL。
//   - tenant_id 从 TenantContext 取,不信任 body。
//   - 路由模块 export 注册函数,不直接改 worker/index.ts。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { TenantContext } from '@xid-kit/types'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { firstIssuePath, readJsonBody } from '../lib/validate'
import { emailDomain } from '../auth/hosted-policy'
import { recordHostedAuthPolicyDenied } from '../auth/hosted-audit'
import { resolveEntryTenant } from '../me-auth/instance-login'
import { requestIp, verifyTurnstile } from '../me-auth/shared'

// 从邮箱地址提取域名部分(如 user@example.com -> example.com)。
// 无 @ 时返回 null。
function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  return email.slice(at + 1).toLowerCase()
}

// HRD 查询结果:匹配到的 SSO connection id 与 org id。
export type HrdResult = {
  organizationId: string
  connectionId: string
  orgId: string
  protocol: 'saml' | 'oidc'
}

// 按邮箱域名查询 verified OrganizationDomain -> SsoConnection(active)。
// 支持精确域名匹配与 wildcard 子域匹配(isWildcard=true 时匹配 *.domain)。
// 返回 null 表示无 verified SSO 路由。
export async function resolveHrd(
  env: Env,
  tenant: TenantContext,
  email: string,
): Promise<HrdResult | null> {
  const policy = tenant.policy.hostedAuth?.enterpriseSso
  if (!policy?.enabled || !policy.allowLogin || !policy.domainDiscovery) return null
  const domain = extractEmailDomain(email)
  if (!domain) return null
  const normalizedDomain = emailDomain(email)
  if (!normalizedDomain) return null
  const hostedAuth = tenant.policy.hostedAuth
  if (hostedAuth?.blockedEmailDomains.includes(normalizedDomain)) return null
  if (
    hostedAuth?.allowedEmailDomains.length &&
    !hostedAuth.allowedEmailDomains.includes(normalizedDomain)
  ) {
    return null
  }
  if (policy.blockedEmailDomains.includes(normalizedDomain)) return null
  if (
    policy.allowedEmailDomains.length > 0 &&
    !policy.allowedEmailDomains.includes(normalizedDomain)
  ) {
    return null
  }

  const db = createTenantDb(env.DB, {
    tenantId: tenant.tenantId,
    issuer: '',
    rpId: '',
    signingKeys: { activeKid: '', defaultAlg: 'ES256', keys: [] },
    policy: {},
  })

  // 先精确匹配,再 wildcard 匹配(父域)。
  const exactDomain = await db.organizationDomains.findOne(
    and(
      eq(schema.organizationDomains.domain, domain),
      eq(schema.organizationDomains.verificationStatus, 'verified'),
      eq(schema.organizationDomains.status, 'active'),
    ),
  )

  let domainRow = exactDomain

  if (!domainRow) {
    // wildcard 匹配:检查父域 example.com 是否被认领且标 isWildcard。
    const parts = domain.split('.')
    if (parts.length > 2) {
      const parentDomain = parts.slice(1).join('.')
      const wildcardRow = await db.organizationDomains.findOne(
        and(
          eq(schema.organizationDomains.domain, parentDomain),
          eq(schema.organizationDomains.verificationStatus, 'verified'),
          eq(schema.organizationDomains.status, 'active'),
          eq(schema.organizationDomains.isWildcard, true),
        ),
      )
      if (wildcardRow) domainRow = wildcardRow
    }
  }

  if (!domainRow) return null

  // 查找该 org 的 active SsoConnection。
  const connection = await db.ssoConnections.findOne(
    and(
      eq(schema.ssoConnections.orgId, domainRow.orgId),
      eq(schema.ssoConnections.status, 'active'),
    ),
  )
  if (!connection) return null

  const protocol = connection.protocol === 'saml' ? 'saml' : 'oidc'
  return {
    organizationId: tenant.tenantId,
    connectionId: connection.id,
    orgId: domainRow.orgId,
    protocol,
  }
}

async function recordHrdPolicyDenied(
  c: Context<XidHonoEnv>,
  tenant: TenantContext,
  email: string,
): Promise<void> {
  const policy = tenant.policy.hostedAuth?.enterpriseSso
  const hostedAuth = tenant.policy.hostedAuth
  const domain = emailDomain(email)
  let reason:
    | 'enterprise_sso_disabled'
    | 'domain_discovery_disabled'
    | 'email_domain_blocked'
    | 'email_domain_not_allowed'
    | 'enterprise_sso_email_domain_blocked'
    | 'enterprise_sso_email_domain_not_allowed'
    | null = null
  if (!policy?.enabled || !policy.allowLogin) reason = 'enterprise_sso_disabled'
  else if (!policy.domainDiscovery) reason = 'domain_discovery_disabled'
  else if (domain && hostedAuth?.blockedEmailDomains.includes(domain)) {
    reason = 'email_domain_blocked'
  } else if (
    domain &&
    hostedAuth?.allowedEmailDomains.length &&
    !hostedAuth.allowedEmailDomains.includes(domain)
  ) {
    reason = 'email_domain_not_allowed'
  } else if (domain && policy.blockedEmailDomains.includes(domain)) {
    reason = 'enterprise_sso_email_domain_blocked'
  } else if (
    domain &&
    policy.allowedEmailDomains.length > 0 &&
    !policy.allowedEmailDomains.includes(domain)
  ) {
    reason = 'enterprise_sso_email_domain_not_allowed'
  }
  if (!reason) return
  await recordHostedAuthPolicyDenied(c, {
    tenant,
    method: 'enterpriseSso',
    action: 'domain_discovery',
    reason,
    identifier: { type: 'email', value: email },
  })
}

// HRD body:email 只做宽松守卫(含 @ 即可,不上 v.email());organizationId 允许 null。
// 失败保持 invalid_request + meta.paramName(SSO 协议错误格式),不走 validation_failed 422。
const hrdBodySchema = v.object({
  email: v.pipe(
    v.string(),
    v.check((value) => value.includes('@')),
  ),
  organizationId: v.optional(v.nullable(v.string())),
  clientId: v.optional(v.nullable(v.string())),
  invitationToken: v.optional(v.nullable(v.string())),
  intent: v.optional(v.nullable(v.string())),
  turnstileToken: v.optional(v.nullable(v.string())),
})

// POST /sso/hrd -- 按邮箱做 Home Realm Discovery。
// body: { email: string, organizationId?: string }
// 返回: { connectionId, orgId, protocol } | { connectionId: null }
async function handleHrd(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_request', { longMessage: 'Request body must be JSON' })

  const parsed = v.safeParse(hrdBodySchema, json.value)
  if (!parsed.success) {
    throw new AppError('invalid_request', {
      meta: { paramName: firstIssuePath(parsed.issues) },
    })
  }

  const { email, organizationId, clientId, invitationToken, intent, turnstileToken } = parsed.output
  await verifyTurnstile(turnstileToken, c.env, requestIp(c))
  const tenant = await resolveEntryTenant(c, { kind: 'email', value: email }, organizationId, {
    invitationToken,
    intent,
    applicationClientId: clientId,
  })
  await recordHrdPolicyDenied(c, tenant, email)
  const result = await resolveHrd(c.env, tenant, email)
  return c.json(result ?? { connectionId: null })
}

const hrd = new Hono<XidHonoEnv>()
hrd.post('/hrd', handleHrd)

export function registerHrdRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/sso', hrd)
}
