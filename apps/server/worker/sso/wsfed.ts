// WS-Federation passive sign-in (enterprise legacy protocol).
// 生产回调按 RSTR 解析 wresult 并经 @xid-kit/saml 验证断言(wsfed-token.ts);wctx 只与服务器端 flow 比对。
// dev/test 环境保留假 IdP 的正则解析分支。

import { sha256Hex } from '@xid-kit/crypto'
import { samlAssertionToSso, toAttributeMapping } from './saml-acs-mapping'
import { verifyWsfedWresult } from './wsfed-token'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { OAUTH_FLOW_STATE_TTL_MS } from '../lib/ttl'
import type { XidHonoEnv } from '../lib/types'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { buildFakeWresult, consumeFakeWsfedState } from '../test-harness/fake-wsfed'
import {
  completeLegacyLogin,
  legacyConfig,
  resolveLegacyConnection,
  type LegacyConnection,
  type LegacyProfile,
} from './legacy-shared'
import { isAssertionReplay } from './saml-do'
import { resolveSsoConnectionTenant, resolveSsoFlowTenant, withTenant } from './tenant'

// callback 的 wresult/wctx 可来自 query 或 POST form,形状同款。
// wresult 是 base64 XML,上限 256KB(schema 层拒超大 payload,与 saml.ts ACS 同约束)。
const wsfedCallbackShapeSchema = v.object({
  wresult: v.optional(v.pipe(v.string(), v.maxLength(256 * 1024))),
  wctx: v.optional(v.string()),
})

type WsfedFlow = {
  tenantId: string
  connectionId: string
  state: string
  createdAt: number
}

type VerifiedWsfedResult = {
  profile: LegacyProfile
  assertionId: string
  notOnOrAfter: number
}

function oauthFlowStub(env: Env, wctx: string): DurableObjectStub {
  const ns = env.OAUTH_STATE
  return ns.get(ns.idFromName(`sso-wsfed:${wctx}`))
}

async function storeWsfedFlow(env: Env, flow: WsfedFlow): Promise<void> {
  const response = await oauthFlowStub(env, flow.state).fetch('https://oauth-flow/store', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...flow, ttlMs: OAUTH_FLOW_STATE_TTL_MS }),
  })
  if (response.status !== 201) throw new AppError('server_error')
}

async function consumeWsfedFlow(env: Env, wctx: string): Promise<WsfedFlow | null> {
  const response = await oauthFlowStub(env, wctx).fetch('https://oauth-flow/consume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: wctx }),
  })
  if (response.status === 404 || response.status === 410) return null
  if (response.status !== 200) throw new AppError('server_error')
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    throw new AppError('server_error', { cause })
  }
  const record =
    body && typeof body === 'object' && 'record' in body
      ? (body as { record?: unknown }).record
      : null
  if (!record || typeof record !== 'object') throw new AppError('server_error')
  const value = record as Record<string, unknown>
  if (
    typeof value['tenantId'] !== 'string' ||
    typeof value['connectionId'] !== 'string' ||
    typeof value['state'] !== 'string' ||
    typeof value['createdAt'] !== 'number'
  ) {
    throw new AppError('server_error')
  }
  return {
    tenantId: value['tenantId'],
    connectionId: value['connectionId'],
    state: value['state'],
    createdAt: value['createdAt'],
  }
}

function decodeWresult(wresult: string): string {
  try {
    return atob(wresult.replace(/\s/g, ''))
  } catch {
    return wresult
  }
}

function profileFromRegex(xml: string): LegacyProfile | null {
  const email =
    /<(?:saml:)?Attribute[^>]*Name="(?:email|mail|emailaddress)"[^>]*>[\s\S]*?<(?:saml:)?AttributeValue[^>]*>([^<]+)/i.exec(
      xml,
    )?.[1] ?? null
  const nameId =
    /<(?:saml:)?NameID[^>]*>([^<]+)<\/(?:saml:)?NameID>/i.exec(xml)?.[1] ?? email ?? null
  if (!nameId) return null
  const firstName =
    /<(?:saml:)?Attribute[^>]*Name="(?:firstName|givenname)"[^>]*>[\s\S]*?<(?:saml:)?AttributeValue[^>]*>([^<]+)/i.exec(
      xml,
    )?.[1] ?? null
  const lastName =
    /<(?:saml:)?Attribute[^>]*Name="(?:lastName|surname)"[^>]*>[\s\S]*?<(?:saml:)?AttributeValue[^>]*>([^<]+)/i.exec(
      xml,
    )?.[1] ?? null
  return {
    idpId: nameId,
    email,
    emailVerified: email !== null,
    firstName,
    lastName,
    groups: [],
    customAttributes: { protocol: 'wsfed' },
  }
}

async function parseWsfedProfileFromWresult(input: {
  c: Context<XidHonoEnv>
  connection: LegacyConnection
  wresult: string
  connectionId: string
}): Promise<VerifiedWsfedResult | null> {
  const { c, connection, wresult, connectionId } = input
  const xml = decodeWresult(wresult)

  if (!isDevOrTestEnvironment(c.env)) {
    const certs = connection.idpCertificates ?? []
    if (certs.length === 0) {
      throw new AppError('signature_invalid', { longMessage: 'wsfed_idp_certificates_missing' })
    }
    const config = legacyConfig(connection)
    const realm = config.wsfedRealm?.trim()
    const reply = config.wsfedReplyUrl?.replace('{connectionId}', encodeURIComponent(connectionId))
    if (!realm || !reply) {
      throw new AppError('internal_error', { longMessage: 'wsfed_connection_misconfigured' })
    }
    const verified = await verifyWsfedWresult(xml, {
      idpCertificatesB64: certs,
      expectedIssuer: connection.idpEntityId ?? '',
      realm,
      replyUrl: reply,
      clockSkewToleranceMs: connection.samlClockSkewMs,
      attributeMapping: toAttributeMapping(connection.attributeMapping),
    })
    // 与 SAML ACS 同一映射:email 可信度交给 JIT 按 org 已验证域名判断,不把「有 email」当已验证。
    const assertion = samlAssertionToSso(connection, verified.subject, verified.attributes)
    return {
      profile: {
        idpId: assertion.idpId,
        email: assertion.email,
        emailVerified: false,
        firstName: assertion.firstName,
        lastName: assertion.lastName,
        groups: assertion.groups,
        customAttributes: { protocol: 'wsfed' },
      },
      assertionId: verified.assertionId,
      notOnOrAfter: verified.notOnOrAfter,
    }
  }

  const profile = profileFromRegex(xml)
  if (!profile) return null
  return {
    profile,
    assertionId: `dev-${await sha256Hex(xml)}`,
    notOnOrAfter: Date.now() + OAUTH_FLOW_STATE_TTL_MS,
  }
}

async function handleWsfedLogin(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })

  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    const connection = await resolveLegacyConnection(c, connectionId, 'wsfed')
    if (!connection.idpSsoUrl) {
      throw new AppError('internal_error', { longMessage: 'wsfed_idp_sso_url_missing' })
    }
    const config = legacyConfig(connection)
    const realm = config.wsfedRealm?.trim()
    const reply = config.wsfedReplyUrl?.replace('{connectionId}', encodeURIComponent(connectionId))
    if (!realm || !reply) {
      throw new AppError('internal_error', { longMessage: 'wsfed_connection_misconfigured' })
    }
    const state = crypto.randomUUID()
    await storeWsfedFlow(c.env, {
      tenantId: tenant.tenantId,
      connectionId,
      state,
      createdAt: Date.now(),
    })
    const url = new URL(connection.idpSsoUrl)
    url.searchParams.set('wa', 'wsignin1.0')
    url.searchParams.set('wtrealm', realm)
    url.searchParams.set('wreply', reply)
    url.searchParams.set('wctx', state)
    if (isDevOrTestEnvironment(c.env)) {
      url.searchParams.set('xid_fake_wsfed', '1')
      url.searchParams.set('xid_state', state)
    }
    return c.redirect(url.toString(), 302)
  })
}

async function handleWsfedCallback(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })

  const queryShape = v.safeParse(wsfedCallbackShapeSchema, {
    wresult: c.req.query('wresult'),
    wctx: c.req.query('wctx'),
  })
  if (!queryShape.success) throw new AppError('invalid_request')
  let wresult = queryShape.output.wresult
  let wctx = queryShape.output.wctx
  if (!wresult && c.req.method === 'POST') {
    const form = await c.req.parseBody()
    const formShape = v.safeParse(wsfedCallbackShapeSchema, {
      wresult: form['wresult'],
      wctx: form['wctx'],
    })
    if (!formShape.success) throw new AppError('invalid_request')
    // form 缺字段时保留 query 通道的值(双通道互补)。
    wresult = formShape.output.wresult ?? wresult
    wctx = formShape.output.wctx ?? wctx
  }
  if (
    (!wresult || typeof wresult !== 'string') &&
    isDevOrTestEnvironment(c.env) &&
    typeof wctx === 'string'
  ) {
    const email = consumeFakeWsfedState(wctx)
    if (email) wresult = buildFakeWresult(email)
  }
  if (typeof wresult !== 'string' || !wresult) {
    throw new AppError('invalid_request', { longMessage: 'wresult_required' })
  }

  const flow = typeof wctx === 'string' ? await consumeWsfedFlow(c.env, wctx) : null
  if (typeof wctx === 'string' && !flow) {
    throw new AppError('invalid_request', { longMessage: 'wctx_invalid' })
  }
  if (flow && (flow.connectionId !== connectionId || flow.state !== wctx)) {
    throw new AppError('invalid_request', { longMessage: 'wctx_connection_mismatch' })
  }
  const tenant = flow
    ? await resolveSsoFlowTenant(c, flow.tenantId)
    : await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    const connection = await resolveLegacyConnection(c, connectionId, 'wsfed')
    const config = legacyConfig(connection)
    if (!flow && config.wsfedAllowIdpInitiated !== true) {
      throw new AppError('access_denied', {
        httpStatus: 403,
        longMessage: 'wsfed_idp_initiated_disabled',
      })
    }
    const assertion = await parseWsfedProfileFromWresult({
      c,
      connection,
      wresult,
      connectionId,
    })
    if (!assertion) {
      throw new AppError('signature_invalid', { longMessage: 'wsfed_wresult_invalid' })
    }
    if (await isAssertionReplay(c, connectionId, assertion.assertionId, assertion.notOnOrAfter)) {
      throw new AppError('replay_detected', { httpStatus: 403 })
    }
    return completeLegacyLogin({
      c,
      connection,
      profile: assertion.profile,
      returnToOrigin: tenant.issuer.replace(/\/$/, ''),
    })
  })
}

const wsfed = new Hono<XidHonoEnv>()
wsfed.get('/:connectionId/login', handleWsfedLogin)
wsfed.post('/:connectionId/callback', handleWsfedCallback)
wsfed.get('/:connectionId/callback', handleWsfedCallback)

export function registerWsfedRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/sso/wsfed', wsfed)
}
