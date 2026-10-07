// /v1/users 与 /v1/sessions 的 Console 能力:筛选、搜索、计数、CSV 导出、详情子资源、管理员动作。
// 真实 sqlite + 迁移链;每个新路由都覆盖跨租户(租户 A 上下文访问租户 B 的用户返回 404,不泄露存在性)。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { registerSessionsRoutes } from '../sessions'
import { registerUsersRoutes } from '../users'
import {
  TENANT_A,
  TENANT_B,
  buildApp,
  envOf,
  json,
  makeDb,
  seedApiKey,
  seedMembership,
  seedOrg,
  seedUser,
  sessionFor,
  tenantDb,
} from './console-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const sendPasswordResetEmail = vi.fn(async () => undefined)
vi.mock('../../me-auth/password-reset-token', () => ({
  sendPasswordResetEmail: (...args: unknown[]) => sendPasswordResetEmail(...(args as [])),
}))

const BASE = 'https://acme.xid.dev/v1'

type UserPage = {
  data: {
    id: string
    primaryEmail: string | null
    signInMethods: { type: string }[]
    organizations: { name: string }[]
  }[]
  total: number
  counts: Record<string, number>
}

async function seedDirectory() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a', name: 'Northwind Logistics' })
  await seedOrg(d1, { id: 'org_fin', name: 'Finance' })
  await seedOrg(d1, { id: 't_b', tenant: TENANT_B, name: 'Other Co' })
  await seedUser(d1, {
    id: 'user_admin',
    email: 'dana.ortiz@northwind.com',
    firstName: 'Dana',
    createdAt: new Date('2026-01-02T00:00:00Z'),
    lastLoginAt: new Date('2026-10-06T00:00:00Z'),
  })
  await seedMembership(d1, { id: 'mem_admin', userId: 'user_admin', orgId: 't_a', role: 'owner' })
  await seedUser(d1, {
    id: 'user_ravi',
    email: 'ravi.shankar@northwind.com',
    phone: '+919845022107',
    externalId: 'okta|00u8h2k1',
    firstName: 'Ravi',
    createdAt: new Date('2026-01-08T00:00:00Z'),
    lastLoginAt: new Date('2026-10-04T00:00:00Z'),
  })
  await seedMembership(d1, { id: 'mem_ravi', userId: 'user_ravi', orgId: 'org_fin' })
  await seedUser(d1, {
    id: 'user_joao',
    phone: '+5511988124417',
    status: 'banned',
    firstName: '=HYPERLINK("x")',
    createdAt: new Date('2026-04-01T00:00:00Z'),
  })
  await seedUser(d1, {
    id: 'user_guest',
    provisionedBy: 'anonymous',
    createdAt: new Date('2026-10-07T00:00:00Z'),
  })
  await seedUser(d1, { id: 'user_gone', email: 'gone@northwind.com', deleted: true })
  await seedUser(d1, {
    id: 'user_other',
    tenant: TENANT_B,
    email: 'ravi.shankar@other.example',
  })
  const db = tenantDb(d1)
  await db.passwords.insert({
    id: 'pw_ravi',
    tenantId: 't_a',
    userId: 'user_ravi',
    hash: 'argon2-hash',
    pepperVersion: 1,
  })
  await db.passkeyCredentials.insert({
    id: 'pk_admin',
    tenantId: 't_a',
    userId: 'user_admin',
    credentialId: 'cred-admin',
    publicKey: Buffer.from('public-key-bytes'),
    coseAlg: -7,
    aaguid: Buffer.alloc(16),
    credentialDeviceType: 'multiDevice',
    backedUp: true,
    deviceName: 'MacBook Pro',
  })
  await db.userIdentities.insert({
    id: 'idn_ravi',
    tenantId: 't_a',
    userId: 'user_ravi',
    identityType: 'sso',
    provider: 'okta',
    providerUserId: '00u8h2k1zzz',
  })
  const token = await seedApiKey(d1, { id: 'ak_all', scopes: ['*'] })
  return { d1, token }
}

describe('GET /v1/users 筛选、搜索与计数', () => {
  let ctx: Awaited<ReturnType<typeof seedDirectory>>
  beforeEach(async () => {
    ctx = await seedDirectory()
  })

  async function list(query: string): Promise<UserPage> {
    const app = buildApp(registerUsersRoutes)
    const res = await app.request(
      `${BASE}/users${query}`,
      { headers: { Authorization: `Bearer ${ctx.token}` } },
      envOf(ctx.d1),
    )
    expect(res.status).toBe(200)
    return json<UserPage>(res)
  }

  it('默认排除已删除用户,按创建时间倒序,并返回主邮箱、登录方式与组织', async () => {
    const page = await list('')

    expect(page.data.map((row) => row.id)).toEqual([
      'user_guest',
      'user_joao',
      'user_ravi',
      'user_admin',
    ])
    const ravi = page.data.find((row) => row.id === 'user_ravi')
    expect(ravi?.primaryEmail).toBe('ravi.shankar@northwind.com')
    expect(ravi?.signInMethods.map((method) => method.type)).toEqual(['password', 'sso'])
    expect(ravi?.organizations.map((org) => org.name)).toEqual(['Finance'])
    expect(page.counts).toEqual({ active: 3, banned: 1, deleted: 1, guest: 1 })
    expect(page.total).toBe(4)
  })

  it('status 筛选:banned 与 deleted 各自命中,不出租户', async () => {
    expect((await list('?status=banned')).data.map((row) => row.id)).toEqual(['user_joao'])
    expect((await list('?status=deleted')).data.map((row) => row.id)).toEqual(['user_gone'])
  })

  it('sign_in_method 筛选:password / passkey / sso / guest 正反例', async () => {
    expect((await list('?sign_in_method=password')).data.map((row) => row.id)).toEqual([
      'user_ravi',
    ])
    expect((await list('?sign_in_method=passkey')).data.map((row) => row.id)).toEqual([
      'user_admin',
    ])
    expect((await list('?sign_in_method=sso')).data.map((row) => row.id)).toEqual(['user_ravi'])
    expect((await list('?sign_in_method=social')).data).toEqual([])
    expect((await list('?sign_in_method=guest')).data.map((row) => row.id)).toEqual(['user_guest'])
  })

  it('创建时间与最后登录时间区间筛选', async () => {
    expect(
      (await list('?created_from=2026-01-05&created_to=2026-05-01')).data.map((row) => row.id),
    ).toEqual(['user_joao', 'user_ravi'])
    expect((await list('?last_sign_in_from=2026-10-05')).data.map((row) => row.id)).toEqual([
      'user_admin',
    ])
  })

  it('搜索命中邮箱、手机号、external id,租户 B 的同名邮箱不出现', async () => {
    expect((await list('?search=ravi.shankar')).data.map((row) => row.id)).toEqual(['user_ravi'])
    expect((await list('?search=98812')).data.map((row) => row.id)).toEqual(['user_joao'])
    expect((await list('?search=okta%7C00u8h2k1')).data.map((row) => row.id)).toEqual(['user_ravi'])
    const percent = await list('?search=%25')
    expect(percent.data).toEqual([])
  })

  it('计数跟随除状态外的筛选条件', async () => {
    const page = await list('?search=northwind.com')
    expect(page.counts).toEqual({ active: 2, banned: 0, deleted: 1, guest: 0 })
  })

  it('非法筛选值返回 422', async () => {
    const app = buildApp(registerUsersRoutes)
    const res = await app.request(
      `${BASE}/users?sign_in_method=fax`,
      { headers: { Authorization: `Bearer ${ctx.token}` } },
      envOf(ctx.d1),
    )
    expect(res.status).toBe(422)
  })
})

describe('/v1/users cookie 守卫', () => {
  it('顶层组织 owner 可读,子组织管理员与无 session 被拒', async () => {
    const { d1 } = await seedDirectory()
    await seedUser(d1, { id: 'user_sub_admin', email: 'sub@northwind.com' })
    await seedMembership(d1, {
      id: 'mem_sub',
      userId: 'user_sub_admin',
      orgId: 'org_fin',
      role: 'admin',
    })

    const owner = await buildApp(registerUsersRoutes, {
      session: sessionFor('user_admin'),
    }).request(`${BASE}/users`, {}, envOf(d1))
    const subAdmin = await buildApp(registerUsersRoutes, {
      session: sessionFor('user_sub_admin'),
    }).request(`${BASE}/users`, {}, envOf(d1))
    const anonymous = await buildApp(registerUsersRoutes).request(`${BASE}/users`, {}, envOf(d1))

    expect(owner.status).toBe(200)
    expect(subAdmin.status).toBe(403)
    expect(anonymous.status).toBe(401)
  })
})

describe('GET /v1/users/export', () => {
  it('CSV 按筛选导出并转义公式单元格,写审计', async () => {
    const { d1, token } = await seedDirectory()
    const env = envOf(d1)
    const res = await buildApp(registerUsersRoutes).request(
      `${BASE}/users/export?format=csv&status=banned`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    const lines = (await res.text()).trim().split('\r\n')
    expect(lines[0]).toBe(
      'id,name,primary_email,primary_phone,status,organizations,created_at,last_sign_in_at',
    )
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`)
    expect(lines[1]).toContain('+5511988124417')
    expect(env.auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.exported', tenantId: 't_a' }),
    )
  })
})

describe('/v1/users/:id 详情子资源', () => {
  let ctx: Awaited<ReturnType<typeof seedDirectory>>
  beforeEach(async () => {
    ctx = await seedDirectory()
  })

  async function get(path: string): Promise<Response> {
    return buildApp(registerUsersRoutes).request(
      `${BASE}${path}`,
      { headers: { Authorization: `Bearer ${ctx.token}` } },
      envOf(ctx.d1),
    )
  }

  it('详情返回邮箱与手机号列表', async () => {
    const body = await json<{ emails: unknown[]; phones: unknown[] }>(await get('/users/user_ravi'))
    expect(body.emails).toEqual([
      expect.objectContaining({ email: 'ravi.shankar@northwind.com', isPrimary: true }),
    ])
    expect(body.phones).toEqual([expect.objectContaining({ phone: '+919845022107' })])
  })

  it('sign-in-methods 不返回公钥或密文,第三方账号 ID 掩码', async () => {
    const admin = await json<Record<string, unknown>>(
      await get('/users/user_admin/sign-in-methods'),
    )
    const ravi = await json<{ identities: { providerUserId: string }[]; hasPassword: boolean }>(
      await get('/users/user_ravi/sign-in-methods'),
    )

    expect(JSON.stringify(admin)).not.toContain('public')
    expect(admin['passkeys']).toEqual([
      expect.objectContaining({ deviceName: 'MacBook Pro', deviceType: 'multiDevice' }),
    ])
    expect(ravi.hasPassword).toBe(true)
    expect(ravi.identities[0]?.providerUserId).toBe('00••••zz')
  })

  it('memberships 返回组织名与角色', async () => {
    const body = await json<{ data: { organizationName: string; role: string }[] }>(
      await get('/users/user_admin/memberships'),
    )
    expect(body.data).toEqual([
      expect.objectContaining({ organizationName: 'Northwind Logistics', role: 'owner' }),
    ])
  })

  it('audit-events 只返回该用户作为操作者或对象的事件', async () => {
    const db = createTenantDb(ctx.d1 as unknown as D1Database, TENANT_A)
    const event = (seq: number, actorId: string, targetId: string | null) =>
      db.auditEvents.insert({
        seq,
        id: `evt_${seq}`,
        tenantId: 't_a',
        eventType: 'user.banned',
        actorId,
        targetType: 'user',
        targetId,
        meta: { password: 'secret' },
        occurredAt: `2026-10-0${seq}T00:00:00.000Z`,
        prevHash: '0',
        hash: String(seq),
      })
    await event(1, 'user_admin', 'user_ravi')
    await event(2, 'user_ravi', null)
    await event(3, 'user_admin', 'user_joao')

    const body = await json<{ data: { id: string; actorName: string; meta: unknown }[] }>(
      await get('/users/user_ravi/audit-events'),
    )
    expect(body.data.map((row) => row.id)).toEqual(['evt_2', 'evt_1'])
    expect(body.data[1]?.actorName).toBe('Dana')
    expect(JSON.stringify(body.data)).not.toContain('secret')
  })

  it.each([
    '/users/user_other',
    '/users/user_other/sign-in-methods',
    '/users/user_other/memberships',
    '/users/user_other/audit-events',
  ])('跨租户 %s 返回 404', async (path) => {
    const res = await get(path)
    expect(res.status).toBe(404)
  })
})

describe('POST /v1/users 带联系方式', () => {
  it('租户内邮箱冲突 409,其他租户的同一邮箱可以创建', async () => {
    const { d1, token } = await seedDirectory()
    const tokenB = await seedApiKey(d1, { id: 'ak_b', scopes: ['*'], tenant: TENANT_B })
    const create = (tenant = TENANT_A, key = token) =>
      buildApp(registerUsersRoutes, { tenant }).request(
        `${BASE}/users`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'Dana.Ortiz@northwind.com', first_name: 'Dana' }),
        },
        envOf(d1),
      )

    const conflict = await create()
    const otherTenant = await create(TENANT_B, tokenB)

    expect(conflict.status).toBe(409)
    expect((await json<{ meta: { paramName: string } }>(conflict)).meta.paramName).toBe('email')
    expect(otherTenant.status).toBe(201)
    const created = await json<{ id: string }>(otherTenant)
    const email = await tenantDb(d1, TENANT_B).userEmails.findOne(
      eq(schema.userEmails.userId, created.id),
    )
    expect(email?.email).toBe('dana.ortiz@northwind.com')
  })

  it('send_password_setup 需要邮箱', async () => {
    const { d1, token } = await seedDirectory()
    const res = await buildApp(registerUsersRoutes).request(
      `${BASE}/users`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'lena', send_password_setup: true }),
      },
      envOf(d1),
    )
    expect(res.status).toBe(422)
  })
})

describe('管理员动作', () => {
  beforeEach(() => sendPasswordResetEmail.mockClear())

  it('password-reset:无主邮箱 422;有主邮箱 202 且响应不含令牌', async () => {
    const { d1, token } = await seedDirectory()
    const post = (id: string) =>
      buildApp(registerUsersRoutes).request(
        `${BASE}/users/${id}/password-reset`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
        envOf(d1),
      )

    const noEmail = await post('user_joao')
    const sent = await post('user_ravi')
    const crossTenant = await post('user_other')

    expect(noEmail.status).toBe(422)
    expect(sent.status).toBe(202)
    expect(await sent.text()).not.toContain('token')
    expect(sendPasswordResetEmail).toHaveBeenCalledOnce()
    expect(crossTenant.status).toBe(404)
  })

  it('mfa/reset:删除验证器、短信与备用码,保留 passkey,并撤销会话', async () => {
    const { d1, token } = await seedDirectory()
    const db = tenantDb(d1)
    for (const factorType of ['totp', 'sms', 'passkey']) {
      await db.mfaFactors.insert({
        id: `mfa_${factorType}`,
        tenantId: 't_a',
        userId: 'user_admin',
        factorType,
        status: 'active',
        passkeyCredentialId: factorType === 'passkey' ? 'pk_admin' : null,
      })
    }
    await db.backupCodes.insert({
      id: 'bc_1',
      tenantId: 't_a',
      userId: 'user_admin',
      batchId: 'b1',
      codeHash: 'hash',
    })
    const env = envOf(d1)

    const res = await buildApp(registerUsersRoutes).request(
      `${BASE}/users/user_admin/mfa/reset`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const factors = await db.mfaFactors.findMany(eq(schema.mfaFactors.userId, 'user_admin'))
    expect(factors.map((row) => row.factorType)).toEqual(['passkey'])
    expect(await db.backupCodes.count(eq(schema.backupCodes.userId, 'user_admin'))).toBe(0)
    expect(
      await db.passkeyCredentials.count(eq(schema.passkeyCredentials.userId, 'user_admin')),
    ).toBe(1)
    expect(env.sessionRevocations).toContain('session:user_admin')
  })

  it('cookie 删除用户需要 step-up;API key 删除撤销会话', async () => {
    const { d1, token } = await seedDirectory()
    await tenantDb(d1).mfaFactors.insert({
      id: 'mfa_admin',
      tenantId: 't_a',
      userId: 'user_admin',
      factorType: 'totp',
      status: 'active',
    })
    const cookieDelete = await buildApp(registerUsersRoutes, {
      session: sessionFor('user_admin'),
    }).request(`${BASE}/users/user_ravi`, { method: 'DELETE' }, envOf(d1))
    const env = envOf(d1)
    const keyDelete = await buildApp(registerUsersRoutes).request(
      `${BASE}/users/user_ravi`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(cookieDelete.status).toBe(401)
    expect((await json(cookieDelete))['code']).toBe('step_up_required')
    expect(keyDelete.status).toBe(204)
    expect(env.sessionRevocations).toContain('session:user_ravi')
  })
})

describe('/v1/sessions', () => {
  async function seedSessions() {
    const ctx = await seedDirectory()
    const db = tenantDb(ctx.d1)
    const base = {
      tenantId: 't_a',
      refreshTokenHash: 'rt-hash',
      deviceFingerprintHash: 'fingerprint-hash',
      authenticatedAt: new Date(1000),
      lastActiveAt: new Date(1000),
      expiresAt: new Date(Date.now() + 3_600_000),
    }
    await db.sessions.insert({ ...base, id: 'sess_joao', userId: 'user_joao' })
    await db.sessions.insert({
      ...base,
      id: 'sess_ravi_imp',
      userId: 'user_ravi',
      refreshTokenHash: 'rt-hash-2',
      isImpersonation: true,
      impersonatorUserId: 'user_admin',
    })
    return ctx
  }

  it('列表按白名单返回,不含指纹与 refresh 哈希,带模拟者显示名', async () => {
    const { d1, token } = await seedSessions()
    const res = await buildApp(registerSessionsRoutes).request(
      `${BASE}/sessions?user_id=user_ravi`,
      { headers: { Authorization: `Bearer ${token}` } },
      envOf(d1),
    )
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).not.toContain('fingerprint')
    expect(body).not.toContain('rt-hash')
    expect(JSON.parse(body).data[0]).toMatchObject({
      id: 'sess_ravi_imp',
      isImpersonation: true,
      impersonatorDisplayName: 'Dana',
    })
  })

  it('revoke_all 对已暂停用户也生效,跨租户 404', async () => {
    const { d1, token } = await seedSessions()
    const env = envOf(d1)
    const app = buildApp(registerSessionsRoutes)
    const banned = await app.request(
      `${BASE}/sessions/users/user_joao/revoke_all`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    const crossTenant = await app.request(
      `${BASE}/sessions/users/user_other/revoke_all`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(banned.status).toBe(200)
    const row = await tenantDb(d1).sessions.findOne(eq(schema.sessions.id, 'sess_joao'))
    expect(row?.status).toBe('revoked')
    expect(crossTenant.status).toBe(404)
  })
})
