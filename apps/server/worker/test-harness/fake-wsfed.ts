// 本地 WS-Fed 被动登录 L3 用假 IdP:/login 按 wtrealm、wreply 签发 RSTR 后带 wresult/wctx 回跳,
// /certificate 给出签名证书与 issuer 供连接配置。xid_token=saml11 时签发 SAML 1.1 断言,缺省 SAML 2.0。

import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { isDevOrTestEnvironment } from './dev-gate'
import { buildFakeWresult, fakeWsfedSigner } from './fake-wsfed-token'

const FAKE_WSFED_PATH = '/test-harness/fake-wsfed'
const FAKE_WSFED_EMAIL = 'wsfed.user@example.com'

const loginQuerySchema = v.object({
  wtrealm: v.pipe(v.string(), v.minLength(1)),
  wreply: v.pipe(v.string(), v.url()),
  wctx: v.optional(v.string()),
  xid_token: v.optional(v.picklist(['saml2', 'saml11'])),
})

export function fakeWsfedIssuer(origin: string): string {
  return `${origin}${FAKE_WSFED_PATH}`
}

function requireHarness(c: Context<XidHonoEnv>): void {
  if (!isDevOrTestEnvironment(c.env)) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
}

async function handleIdpLogin(c: Context<XidHonoEnv>): Promise<Response> {
  requireHarness(c)
  const query = v.safeParse(loginQuerySchema, {
    wtrealm: c.req.query('wtrealm'),
    wreply: c.req.query('wreply'),
    wctx: c.req.query('wctx'),
    xid_token: c.req.query('xid_token'),
  })
  if (!query.success) throw new AppError('invalid_request')
  const wresult = await buildFakeWresult({
    issuer: fakeWsfedIssuer(new URL(c.req.url).origin),
    realm: query.output.wtrealm,
    reply: query.output.wreply,
    email: FAKE_WSFED_EMAIL,
    tokenType: query.output.xid_token ?? 'saml2',
  })
  const url = new URL(query.output.wreply)
  url.searchParams.set('wa', 'wsignin1.0')
  url.searchParams.set('wresult', wresult)
  if (query.output.wctx) url.searchParams.set('wctx', query.output.wctx)
  return c.redirect(url.toString(), 302)
}

async function handleCertificate(c: Context<XidHonoEnv>): Promise<Response> {
  requireHarness(c)
  const signer = await fakeWsfedSigner()
  return c.json({
    issuer: fakeWsfedIssuer(new URL(c.req.url).origin),
    certificateB64: signer.certificateB64,
  })
}

const fakeWsfed = new Hono<XidHonoEnv>()
fakeWsfed.get('/login', handleIdpLogin)
fakeWsfed.get('/certificate', handleCertificate)

export function registerFakeWsfedRoutes(app: Hono<XidHonoEnv>): void {
  app.route(FAKE_WSFED_PATH, fakeWsfed)
}
