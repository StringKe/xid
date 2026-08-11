// 本地 LDAP direct bind L3 用假 bind 端点。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { isDevOrTestEnvironment } from './dev-gate'

export type FakeLdapProfile = {
  idpId: string
  email: string | null
  emailVerified: boolean
  firstName: string | null
  lastName: string | null
  groups: string[]
  customAttributes: Record<string, unknown>
}

const FAKE_LDAP_USERS: Record<string, { password: string; profile: FakeLdapProfile }> = {
  'ldap.user@example.com': {
    password: 'ldap-pass',
    profile: {
      idpId: 'uid=ldap.user,dc=example,dc=com',
      email: 'ldap.user@example.com',
      emailVerified: true,
      firstName: 'LDAP',
      lastName: 'User',
      groups: ['Engineering'],
      customAttributes: { protocol: 'ldap' },
    },
  },
}

export function fakeLdapBind(username: string, password: string): FakeLdapProfile | null {
  const entry = FAKE_LDAP_USERS[username]
  if (!entry || entry.password !== password) return null
  return entry.profile
}

function requireHarness(c: Context<XidHonoEnv>): void {
  if (!isDevOrTestEnvironment(c.env)) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
}

async function handleBind(c: Context<XidHonoEnv>): Promise<Response> {
  requireHarness(c)
  const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string }
  const username = body.username?.trim() ?? ''
  const password = body.password ?? ''
  const profile = fakeLdapBind(username, password)
  if (!profile) return c.json({ code: 'invalid_credentials' }, 401)
  return c.json(profile, 200)
}

const fakeLdap = new Hono<XidHonoEnv>()
fakeLdap.post('/bind', handleBind)

export function registerFakeLdapRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/test-harness/fake-ldap', fakeLdap)
}
