// Members(改角色、最后一位 owner、批量邀请、重发邀请)、Applications(项目归属、项目管理者授权、
// 显示与登出字段)与 UserGrants(按用户跨项目查询)的 Console 能力。真实 sqlite + 迁移链,含跨租户用例。

import { describe, expect, it, vi } from 'vitest'
import { schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { registerApplications } from '../applications'
import { registerInvitationActionRoutes } from '../invitation-actions'
import { registerInvitationsRoutes } from '../invitations'
import { registerMembershipsRoutes } from '../memberships'
import { registerOrgMembersRoutes } from '../org-members'
import { registerUserGrants } from '../user-grants'
import {
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

const BASE = 'https://acme.xid.dev/v1'

async function seedOrgWithPeople() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a', name: 'Northwind Logistics' })
  await seedOrg(d1, { id: 't_b', tenant: TENANT_B, name: 'Other Co' })
  await seedUser(d1, { id: 'user_owner', email: 'dana@northwind.com', firstName: 'Dana' })
  await seedUser(d1, { id: 'user_admin', email: 'amara@northwind.com' })
  await seedUser(d1, { id: 'user_member', email: 'wen@northwind.com' })
  await seedMembership(d1, { id: 'mem_owner', userId: 'user_owner', orgId: 't_a', role: 'owner' })
  await seedMembership(d1, { id: 'mem_admin', userId: 'user_admin', orgId: 't_a', role: 'admin' })
  await seedMembership(d1, { id: 'mem_member', userId: 'user_member', orgId: 't_a' })
  await seedUser(d1, { id: 'user_b', tenant: TENANT_B, email: 'b@other.example' })
  await seedMembership(d1, {
    id: 'mem_b',
    userId: 'user_b',
    orgId: 't_b',
    role: 'owner',
    tenant: TENANT_B,
  })
  return d1
}

function patchMembership(
  d1: ReturnType<typeof makeDb>,
  actor: string,
  path: string,
  body: Record<string, unknown>,
) {
  return buildApp(registerMembershipsRoutes, { session: sessionFor(actor) }).request(
    `${BASE}/organizations/${path}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    envOf(d1),
  )
}

describe('memberships 改角色与最后一位 owner', () => {
  it('唯一 owner 降级返回 last_owner', async () => {
    const d1 = await seedOrgWithPeople()
    const res = await patchMembership(d1, 'user_owner', 't_a/memberships/mem_owner', {
      role: 'admin',
    })
    expect(res.status).toBe(409)
    expect((await json(res))['code']).toBe('last_owner')
  })

  it('admin 不能把成员升为 owner,owner 可以', async () => {
    const d1 = await seedOrgWithPeople()
    const byAdmin = await patchMembership(d1, 'user_admin', 't_a/memberships/mem_member', {
      role: 'owner',
    })
    const byOwner = await patchMembership(d1, 'user_owner', 't_a/memberships/mem_member', {
      role: 'owner',
    })

    expect(byAdmin.status).toBe(403)
    expect(byOwner.status).toBe(200)
    const row = await tenantDb(d1).memberships.findOne(eq(schema.memberships.id, 'mem_member'))
    expect(row?.role).toBe('owner')
  })

  it('跨租户 membership 返回 404', async () => {
    const d1 = await seedOrgWithPeople()
    const res = await patchMembership(d1, 'user_owner', 't_b/memberships/mem_b', { role: 'admin' })
    expect(res.status).toBe(404)
  })
})

describe('members 列表筛选与计数', () => {
  it('按角色与姓名或邮箱筛选,返回 owner / admin 计数与加入方式', async () => {
    const d1 = await seedOrgWithPeople()
    const app = buildApp(registerOrgMembersRoutes, { session: sessionFor('user_admin') })
    const env = envOf(d1)

    const admins = await json<{ data: { userId: string }[]; counts: unknown }>(
      await app.request(`${BASE}/organizations/t_a/members?role=admin`, {}, env),
    )
    const searched = await json<{
      data: { userId: string; joinedThrough: string }[]
      total: number
    }>(await app.request(`${BASE}/organizations/t_a/members?search=wen%40north`, {}, env))

    expect(admins.data.map((row) => row.userId)).toEqual(['user_admin'])
    expect(admins.counts).toEqual({ owner: 1, admin: 1 })
    expect(searched.data).toEqual([
      expect.objectContaining({ userId: 'user_member', joinedThrough: 'added' }),
    ])
    expect(searched.total).toBe(1)
  })
})

describe('批量邀请与重发', () => {
  it('逐条返回 created / already_member / already_invited', async () => {
    const d1 = await seedOrgWithPeople()
    const res = await buildApp(registerInvitationActionRoutes, {
      session: sessionFor('user_admin'),
    }).request(
      `${BASE}/organizations/t_a/invitations/bulk`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invitations: [
            { email: 'lena@muller-freight.de' },
            { email: 'wen@northwind.com' },
            { email: 'LENA@muller-freight.de' },
          ],
        }),
      },
      envOf(d1),
    )

    expect(res.status).toBe(200)
    const body = await json<{ data: { email: string; result: string; token?: string }[] }>(res)
    expect(body.data.map((row) => row.result)).toEqual([
      'created',
      'already_member',
      'already_invited',
    ])
    expect(body.data[0]?.token).toBeUndefined()
  })

  it('批量邀请受租户限速约束', async () => {
    const d1 = await seedOrgWithPeople()
    const res = await buildApp(registerInvitationActionRoutes, {
      session: sessionFor('user_admin'),
    }).request(
      `${BASE}/organizations/t_a/invitations/bulk`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitations: [{ email: 'lena@muller-freight.de' }] }),
      },
      envOf(d1, { rateLimitAllowed: false }),
    )
    expect(res.status).toBe(429)
  })

  it('重发换新 token 哈希并延长有效期;跨租户 404', async () => {
    const d1 = await seedOrgWithPeople()
    await tenantDb(d1).invitations.insert({
      id: 'inv_1',
      tenantId: 't_a',
      orgId: 't_a',
      email: 'joao@northwind.com',
      tokenHash: 'old-hash',
      tokenVersion: 'locator_v1',
      expiresAt: new Date(Date.now() + 1000),
    })
    const app = buildApp(
      (parent) => {
        registerInvitationsRoutes(parent)
        registerInvitationActionRoutes(parent)
      },
      { session: sessionFor('user_admin') },
    )
    const env = envOf(d1)

    const res = await app.request(
      `${BASE}/organizations/t_a/invitations/inv_1/resend`,
      { method: 'POST' },
      env,
    )
    const crossTenant = await app.request(
      `${BASE}/organizations/t_b/invitations/inv_1/resend`,
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('hash')
    const row = await tenantDb(d1).invitations.findOne(eq(schema.invitations.id, 'inv_1'))
    expect(row?.tokenHash).not.toBe('old-hash')
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 86_400_000)
    expect(env.emailSend).toHaveBeenCalledOnce()
    expect(crossTenant.status).toBe(404)
  })
})

async function seedProjects() {
  const d1 = await seedOrgWithPeople()
  const db = tenantDb(d1)
  await seedOrg(d1, { id: 'org_fin', name: 'Finance' })
  for (const [id, name] of [
    ['proj_fleet', 'Fleet'],
    ['proj_finance', 'Finance'],
  ] as const) {
    await db.projects.insert({ id, tenantId: 't_a', orgId: 'org_fin', name })
  }
  await tenantDb(d1, TENANT_B).projects.insert({
    id: 'proj_b',
    tenantId: 't_b',
    orgId: 't_b',
    name: 'Other',
  })
  await seedUser(d1, { id: 'user_pm', email: 'ravi@northwind.com' })
  await db.managerAssignments.insert({
    id: 'mgr_pm',
    tenantId: 't_a',
    userId: 'user_pm',
    managerRole: 'project_manager',
    scopeType: 'project',
    scopeId: 'proj_fleet',
  })
  const base = {
    tenantId: 't_a',
    clientSecretHash: null,
    clientType: 'public',
    tokenEndpointAuthMethod: 'none',
    redirectUris: ['https://fleet.northwind.com/cb'],
    allowedGrantTypes: ['authorization_code'],
    allowedScopes: ['openid'],
  }
  await db.applications.insert({
    ...base,
    id: 'app_fleet',
    clientId: 'c_fleet',
    projectId: 'proj_fleet',
    name: 'Fleet Planner',
  })
  await db.applications.insert({
    ...base,
    id: 'app_fin',
    clientId: 'c_fin',
    projectId: 'proj_finance',
  })
  const token = await seedApiKey(d1, { id: 'ak_apps', scopes: ['*'] })
  return { d1, token }
}

describe('applications 项目归属与项目管理者授权', () => {
  it('项目管理者只见本项目应用;不带 project_id 403;越项目 404', async () => {
    const { d1 } = await seedProjects()
    const app = buildApp(registerApplications, { session: sessionFor('user_pm') })
    const env = envOf(d1)

    const own = await app.request(`${BASE}/applications?project_id=proj_fleet`, {}, env)
    const all = await app.request(`${BASE}/applications`, {}, env)
    const otherList = await app.request(`${BASE}/applications?project_id=proj_finance`, {}, env)
    const otherApp = await app.request(`${BASE}/applications/app_fin`, {}, env)

    expect(own.status).toBe(200)
    const body = await json<{ data: { id: string; name: string }[] }>(own)
    expect(body.data).toEqual([expect.objectContaining({ id: 'app_fleet', name: 'Fleet Planner' })])
    expect(all.status).toBe(403)
    expect(otherList.status).toBe(403)
    expect(otherApp.status).toBe(404)
  })

  it('name 为空时回退 client_id;顶层组织 owner 可见全部', async () => {
    const { d1 } = await seedProjects()
    const res = await buildApp(registerApplications, { session: sessionFor('user_owner') }).request(
      `${BASE}/applications`,
      {},
      envOf(d1),
    )
    const body = await json<{ data: { id: string; name: string }[] }>(res)
    expect(body.data.find((row) => row.id === 'app_fin')?.name).toBe('c_fin')
    expect(body.data).toHaveLength(2)
  })

  it('创建:缺 name 422;他租户项目 422;登出 URI 非 https 422;字段读回', async () => {
    const { d1, token } = await seedProjects()
    const post = (body: Record<string, unknown>) =>
      buildApp(registerApplications).request(
        `${BASE}/applications`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: ['https://driver.northwind.com/cb'], ...body }),
        },
        envOf(d1),
      )

    expect((await post({})).status).toBe(422)
    expect((await post({ name: 'Driver App', project_id: 'proj_b' })).status).toBe(422)
    expect(
      (await post({ name: 'Driver App', backchannel_logout_uri: 'http://driver.example/logout' }))
        .status,
    ).toBe(422)
    const created = await post({
      name: 'Driver App',
      project_id: 'proj_fleet',
      application_type: 'native',
      frontchannel_logout_uri: 'https://driver.northwind.com/logout',
      first_party: true,
    })
    expect(created.status).toBe(201)
    expect(await json(created)).toMatchObject({
      name: 'Driver App',
      project_id: 'proj_fleet',
      application_type: 'native',
      frontchannel_logout_uri: 'https://driver.northwind.com/logout',
      first_party: true,
    })
  })

  it('项目管理者不能把应用移到自己不管理的项目', async () => {
    const { d1 } = await seedProjects()
    const res = await buildApp(registerApplications, { session: sessionFor('user_pm') }).request(
      `${BASE}/applications/app_fleet`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'proj_finance' }),
      },
      envOf(d1),
    )
    expect(res.status).toBe(422)
  })
})

describe('user-grants 按用户查询', () => {
  async function seedGrants() {
    const ctx = await seedProjects()
    const db = tenantDb(ctx.d1)
    await db.roles.insert({
      id: 'role_dispatcher',
      tenantId: 't_a',
      projectId: 'proj_fleet',
      key: 'dispatcher',
      displayName: 'Dispatcher',
    })
    await db.userGrants.insert({
      id: 'ug_1',
      tenantId: 't_a',
      userId: 'user_member',
      projectId: 'proj_fleet',
      roleId: 'role_dispatcher',
    })
    await db.userGrants.insert({
      id: 'ug_2',
      tenantId: 't_a',
      userId: 'user_member',
      projectId: 'proj_fleet',
      roleId: 'role_dispatcher',
      grantedViaGrantId: 'grant_1',
    })
    return ctx
  }

  it('顶层组织管理员只带 user_id 得到角色名、项目名与授予来源', async () => {
    const { d1 } = await seedGrants()
    const res = await buildApp(registerUserGrants, { session: sessionFor('user_admin') }).request(
      `${BASE}/user-grants?user_id=user_member`,
      {},
      envOf(d1),
    )
    expect(res.status).toBe(200)
    const body = await json<{ data: Record<string, unknown>[] }>(res)
    expect(body.data).toEqual([
      expect.objectContaining({
        role_name: 'Dispatcher',
        project_name: 'Fleet',
        granted_via: 'direct',
      }),
      expect.objectContaining({ granted_via: 'project_grant' }),
    ])
  })

  it('项目管理者不带 project_id 仍被拒;他租户用户不可见', async () => {
    const { d1 } = await seedGrants()
    const pm = await buildApp(registerUserGrants, { session: sessionFor('user_pm') }).request(
      `${BASE}/user-grants?user_id=user_member`,
      {},
      envOf(d1),
    )
    const otherTenant = await buildApp(registerUserGrants, {
      session: sessionFor('user_b'),
      tenant: TENANT_B,
    }).request(`${BASE}/user-grants?user_id=user_member`, {}, envOf(d1))

    expect(pm.status).toBe(422)
    expect(otherTenant.status).toBe(200)
    expect((await json<{ data: unknown[] }>(otherTenant)).data).toEqual([])
  })
})
