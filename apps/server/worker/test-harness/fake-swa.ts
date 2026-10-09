// 本地 SWA L3 用的假下游应用登录表单:接收 launch 页自动提交的表单,校验字段名与凭据。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { isDevOrTestEnvironment } from './dev-gate'

const FAKE_SWA_USERNAME_FIELD = 'login_id'
const FAKE_SWA_PASSWORD_FIELD = 'passcode'

const FAKE_SWA_ACCOUNTS: Record<string, string> = {
  swauser: 'SwaDownstream42',
}

function requireHarness(c: Context<XidHonoEnv>): void {
  if (!isDevOrTestEnvironment(c.env)) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
}

async function handleLogin(c: Context<XidHonoEnv>): Promise<Response> {
  requireHarness(c)
  const form = await c.req.parseBody()
  const username = form[FAKE_SWA_USERNAME_FIELD]
  const password = form[FAKE_SWA_PASSWORD_FIELD]
  const expected = typeof username === 'string' ? FAKE_SWA_ACCOUNTS[username] : undefined
  if (expected === undefined || password !== expected) {
    return c.json({ signedIn: false }, 401)
  }
  return c.json({ signedIn: true, username }, 200)
}

const fakeSwa = new Hono<XidHonoEnv>()
fakeSwa.post('/login', handleLogin)

export function registerFakeSwaRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/test-harness/fake-swa', fakeSwa)
}
