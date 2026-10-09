// 出站 SAML IdP 共用部分:IdP 端点、SP 解析、POST 绑定表单和租户切换。

import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { isLoopbackHttpUrl, isPublicHttpsUrl } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { resolveSamlServiceProviderTenant, withTenant } from './tenant'

export type SamlServiceProvider = typeof schema.samlServiceProviders.$inferSelect

export const OUTBOUND_AUTHN_REQUEST_SIGNATURE_REQUIRED = false
export const RELAY_STATE_MAX_LENGTH = 2048
export const SAML_XML_BASE64_MAX_LENGTH = 256 * 1024

export function requiredParam(c: Context<XidHonoEnv>, name: string): string {
  const value = c.req.param(name)
  if (!value) throw new AppError('invalid_request', { httpStatus: 400 })
  return value
}

export function readRelayState(value: string | undefined): string | null {
  if (value === undefined) return null
  if (value.length > RELAY_STATE_MAX_LENGTH) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  return value
}

export type OutboundSamlIdpEndpoints = {
  entityId: string
  metadataUrl: string
  ssoUrl: string
  sloUrl: string
}

// SaaS 管理员要填写的 IdP 端点,全部基于实例 issuer。
export function outboundSamlIdpEndpoints(issuer: string, appId: string): OutboundSamlIdpEndpoints {
  const entityId = `${issuer}/sso/outbound/saml/${encodeURIComponent(appId)}`
  return {
    entityId,
    metadataUrl: `${entityId}/metadata`,
    ssoUrl: `${entityId}/sso`,
    sloUrl: `${entityId}/slo`,
  }
}

export function idpEntityId(c: Context<XidHonoEnv>, appId: string): string {
  return outboundSamlIdpEndpoints(c.get('tenant').issuer, appId).entityId
}

export function idpSsoUrl(c: Context<XidHonoEnv>, appId: string): string {
  return outboundSamlIdpEndpoints(c.get('tenant').issuer, appId).ssoUrl
}

export function idpSloUrl(c: Context<XidHonoEnv>, appId: string): string {
  return outboundSamlIdpEndpoints(c.get('tenant').issuer, appId).sloUrl
}

export async function resolveSp(
  c: Context<XidHonoEnv>,
  appId: string,
): Promise<SamlServiceProvider> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.samlServiceProviders.findOne(eq(schema.samlServiceProviders.id, appId))
  const permitsLoopbackHttp = isDevOrTestEnvironment(c.env)
  const endpointAllowed = (value: string): boolean =>
    isPublicHttpsUrl(value) || (permitsLoopbackHttp && isLoopbackHttpUrl(value))
  if (
    !row ||
    !endpointAllowed(row.acsUrl) ||
    (row.sloUrl !== null && row.sloUrl !== undefined && !endpointAllowed(row.sloUrl))
  ) {
    throw new AppError('connection_not_found', { httpStatus: 404 })
  }
  return row
}

export function postBindingForm(input: {
  destination: string
  samlMessage: string
  fieldName: 'SAMLRequest' | 'SAMLResponse'
  relayState: string | null
}): string {
  const relay =
    input.relayState !== null
      ? `<input type="hidden" name="RelayState" value="${htmlEscape(input.relayState)}">`
      : ''
  return [
    `<!doctype html>`,
    `<html><body>`,
    `<form method="post" action="${htmlEscape(input.destination)}">`,
    `<input type="hidden" name="${input.fieldName}" value="${htmlEscape(input.samlMessage)}">`,
    relay,
    `</form>`,
    `<script>document.forms[0].submit()</script>`,
    `</body></html>`,
  ].join('')
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function withOutboundTenant<T>(
  c: Context<XidHonoEnv>,
  appId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tenant = await resolveSamlServiceProviderTenant(c, appId)
  return withTenant(c, tenant, fn)
}
