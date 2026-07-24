// WS-Federation passive sign-in (enterprise legacy protocol).
// Minimal local baseline: SP-initiated redirect to IdP SSO URL and callback wresult parsing.
// Production callbacks require signed wresult validation against configured IdP certificates.

import { verifySamlResponse } from '@xid-kit/saml'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
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
import { resolveSsoConnectionTenant, withTenant } from './tenant'

// WS-Fed passive redirect 参数全可选(缺省回落 connection 配置);query 必然全 string,
// schema 只为统一形状层入口,失败保持 invalid_request。
const wsfedLoginQuerySchema = v.object({
  wtrealm: v.optional(v.string()),
  wreply: v.optional(v.string()),
})

// callback 的 wresult/wctx 可来自 query 或 POST form,形状同款。
// wresult 是 base64 XML,上限 256KB(schema 层拒超大 payload,与 saml.ts ACS 同约束)。
const wsfedCallbackShapeSchema = v.object({
  wresult: v.optional(v.pipe(v.string(), v.maxLength(256 * 1024))),
  wctx: v.optional(v.string()),
})

function wsfedCallbackUrl(issuer: string, connectionId: string): string {
  return `${issuer.replace(/\/$/, '')}/sso/wsfed/${connectionId}/callback`
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
  issuer: string
  connectionId: string
}): Promise<LegacyProfile | null> {
  const { c, connection, wresult, issuer, connectionId } = input
  const xml = decodeWresult(wresult)

  if (!isDevOrTestEnvironment(c.env)) {
    const certs = connection.idpCertificates ?? []
    if (certs.length === 0) {
      throw new AppError('signature_invalid', { longMessage: 'wsfed_idp_certificates_missing' })
    }
    const config = legacyConfig(connection)
    const realm = config.wsfedRealm ?? issuer
    const reply = config.wsfedReplyUrl ?? wsfedCallbackUrl(issuer, connectionId)
    const verified = await verifySamlResponse(xml, {
      idpCertificatesB64: certs,
      expectedIssuer: connection.idpEntityId ?? '',
      expectedAudience: realm,
      acsUrl: reply,
      spInitiated: 'auto',
      wantAuthnResponseSigned: true,
      wantAssertionsSigned: true,
    })
    if (!verified.ok) {
      throw new AppError('signature_invalid', { longMessage: verified.error.reason })
    }
    const email =
      (typeof verified.value.attributes.email === 'string'
        ? verified.value.attributes.email
        : null) ??
      verified.value.subject.nameId ??
      null
    const firstName =
      typeof verified.value.attributes.firstName === 'string'
        ? verified.value.attributes.firstName
        : null
    const lastName =
      typeof verified.value.attributes.lastName === 'string'
        ? verified.value.attributes.lastName
        : null
    const nameId = verified.value.subject.nameId
    if (!nameId) return null
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

  return profileFromRegex(xml)
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
    const query = v.safeParse(wsfedLoginQuerySchema, {
      wtrealm: c.req.query('wtrealm'),
      wreply: c.req.query('wreply'),
    })
    if (!query.success) throw new AppError('invalid_request')
    const config = legacyConfig(connection)
    const realm = query.output.wtrealm ?? config.wsfedRealm ?? tenant.issuer
    const reply =
      query.output.wreply ?? config.wsfedReplyUrl ?? wsfedCallbackUrl(tenant.issuer, connectionId)
    const state = crypto.randomUUID()
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
    // form 缺字段时保留 query 通道的值(双通道互补,与历史行为一致)。
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

  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    const connection = await resolveLegacyConnection(c, connectionId, 'wsfed')
    const profile = await parseWsfedProfileFromWresult({
      c,
      connection,
      wresult,
      issuer: tenant.issuer.replace(/\/$/, ''),
      connectionId,
    })
    if (!profile) throw new AppError('signature_invalid', { longMessage: 'wsfed_wresult_invalid' })
    return completeLegacyLogin({
      c,
      connection,
      profile,
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
