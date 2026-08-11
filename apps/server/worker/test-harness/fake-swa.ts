// 本地 SWA/密码保管 L3 用假 authenticate 端点。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { isDevOrTestEnvironment } from './dev-gate'

export type FakeSwaProfile = {
  idpId: string
  email: string | null
  emailVerified: boolean
  firstName: string | null
  lastName: string | null
  groups: string[]
  customAttributes: Record<string, unknown>
}

const FAKE_SWA_USERS: Record<string, { password: string; profile: FakeSwaProfile }> = {
  'swa.user@example.com': {
    password: 'swa-pass',
    profile: {
      idpId: 'swa.user@example.com',
      email: 'swa.user@example.com',
      emailVerified: true,
      firstName: 'SWA',
      lastName: 'User',
      groups: [],
      customAttributes: { protocol: 'swa' },
    },
  },
}

export function fakeSwaAuthenticate(username: string, password: string): FakeSwaProfile | null {
  const entry = FAKE_SWA_USERS[username]
  if (!entry || entry.password !== password) return null
  return entry.profile
}

function requireHarness(c: Context<XidHonoEnv>): void {
  if (!isDevOrTestEnvironment(c.env)) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
}

async function handleAuthenticate(c: Context<XidHonoEnv>): Promise<Response> {
  requireHarness(c)
  const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string }
  const username = body.username?.trim() ?? ''
  const password = body.password ?? ''
  const profile = fakeSwaAuthenticate(username, password)
  if (!profile) return c.json({ code: 'invalid_credentials' }, 401)
  return c.json(profile, 200)
}

const fakeSwa = new Hono<XidHonoEnv>()
fakeSwa.post('/authenticate', handleAuthenticate)

export function registerFakeSwaRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/test-harness/fake-swa', fakeSwa)
}
