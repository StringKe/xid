#!/usr/bin/env node

import {
  baseUrl,
  collectSetCookie,
  d1,
  fetchText,
  parseJson,
  readFileInputValue,
  requireFileInputValue,
  printResult,
  readInputValue,
  requireInputValue,
  sha256Hex,
  sqlString,
} from './production-auth.mjs'
import {
  beginProductionEvidence,
  EVIDENCE_KEYS,
  EVIDENCE_MARKERS,
  recordProductionEvidence,
} from './production-evidence.mjs'

function inferOidcConnectionId(callbackUrl) {
  const url = new URL(callbackUrl)
  const match = url.pathname.match(/^\/sso\/oidc\/([^/]+)\/callback$/u)
  if (!match?.[1])
    throw new Error('enterprise OIDC callback URL must target /sso/oidc/{connection}/callback')
  return match[1]
}

async function fetchOidcCallback(callbackUrl) {
  const url = new URL(callbackUrl)
  if (url.origin !== baseUrl) throw new Error('enterprise OIDC callback URL origin mismatch')
  const { res, text } = await fetchText(`${url.pathname}${url.search}`, {
    headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
  })
  if (res.status !== 302) {
    throw new Error(
      `enterprise OIDC callback did not redirect http=${res.status} body=${text.slice(0, 120)}`,
    )
  }
  const cookie = collectSetCookie(res)
  if (!cookie.includes('__Host-xid.rt.')) {
    throw new Error('enterprise OIDC callback did not set session cookie')
  }
  return cookie
}

async function postSamlAcs(connectionId, samlResponse, relayState) {
  const form = new URLSearchParams({ SAMLResponse: samlResponse })
  if (relayState) form.set('RelayState', relayState)
  const { res, text } = await fetchText(`/sso/saml/${encodeURIComponent(connectionId)}/acs`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  if (res.status !== 302) {
    throw new Error(
      `enterprise SAML ACS did not redirect http=${res.status} body=${text.slice(0, 120)}`,
    )
  }
  const cookie = collectSetCookie(res)
  if (!cookie.includes('__Host-xid.rt.')) {
    throw new Error('enterprise SAML ACS did not set session cookie')
  }
  return cookie
}

async function verifyEnterpriseSession(cookie, connectionId, expectedOrgId) {
  const { res, text } = await fetchText('/v1/me', { cookie })
  if (res.status !== 200) throw new Error(`/v1/me failed after enterprise SSO http=${res.status}`)
  const body = parseJson(text, '/v1/me enterprise sso')
  if (!body?.user?.id) throw new Error('/v1/me enterprise user id missing')
  if (!body?.activeOrg?.id) throw new Error('/v1/me enterprise activeOrg missing')
  if (expectedOrgId && body.activeOrg.id !== expectedOrgId) {
    throw new Error('/v1/me enterprise activeOrg mismatch')
  }
  const connectionRows = await d1(
    `
SELECT id, protocol, org_id, status
FROM sso_connections
WHERE id = ${sqlString(connectionId)}
LIMIT 1;
`,
    'load enterprise sso connection',
  )
  const connection = connectionRows[0]
  if (!connection) throw new Error('enterprise sso connection not found in production D1')
  if (connection.status !== 'active') throw new Error('enterprise sso connection is not active')
  if (connection.org_id !== body.activeOrg.id) {
    throw new Error('enterprise sso connection org mismatch')
  }
  const sessionCookie = cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('__Host-xid.rt.'))
  const refreshToken = sessionCookie?.split('=').slice(1).join('=')
  if (!refreshToken) throw new Error('enterprise session cookie value missing')
  const rows = await d1(
    `
SELECT id, tenant_id, user_id, active_org_id, status
FROM sessions
WHERE refresh_token_hash = ${sqlString(await sha256Hex(refreshToken))}
LIMIT 1;
`,
    'load enterprise sso session',
  )
  const session = rows[0]
  if (!session) throw new Error('enterprise sso session was not written to production D1')
  if (session.status !== 'active') throw new Error('enterprise sso session is not active')
  if (session.user_id !== body.user.id) throw new Error('enterprise sso session user mismatch')
  if (session.active_org_id !== body.activeOrg.id) {
    throw new Error('enterprise sso session active organization mismatch')
  }
  const identityRows = await d1(
    `
SELECT COUNT(*) AS count
FROM user_identities
WHERE tenant_id = ${sqlString(body.activeOrg.id)}
  AND user_id = ${sqlString(body.user.id)}
  AND provider = ${sqlString(connectionId)}
  AND identity_type IN ('sso', 'saml')
  AND revoked_at IS NULL;
`,
    'verify enterprise sso identity',
  )
  if (Number(identityRows[0]?.count ?? 0) < 1) {
    throw new Error('enterprise sso identity was not linked in production D1')
  }
  printResult('PASS', 'enterprise sso provider callback', `connection=${connectionId}`)
  printResult('PASS', 'enterprise sso cookie', `protocol=${connection.protocol}`)
  printResult('PASS', 'enterprise sso me active organization', `org=${body.activeOrg.id}`)
}

export async function runProductionEnterpriseSsoSmoke() {
  const preSmokeContext = await beginProductionEvidence()
  const expectedOrgId = await readInputValue('XID_PRODUCTION_ENTERPRISE_SSO_ORGANIZATION_ID')
  const samlResponse = await readFileInputValue('XID_PRODUCTION_ENTERPRISE_SSO_SAML_RESPONSE')
  if (samlResponse) {
    const connectionId = await requireInputValue('XID_PRODUCTION_ENTERPRISE_SSO_CONNECTION_ID')
    const relayState = await readInputValue('XID_PRODUCTION_ENTERPRISE_SSO_RELAY_STATE')
    const cookie = await postSamlAcs(connectionId, samlResponse, relayState)
    await verifyEnterpriseSession(cookie, connectionId, expectedOrgId)
    await recordProductionEvidence(
      EVIDENCE_KEYS.enterpriseSsoFull,
      EVIDENCE_MARKERS.enterpriseSsoFull,
      preSmokeContext,
    )
    printResult('PASS', 'production evidence recorded', EVIDENCE_KEYS.enterpriseSsoFull)
    return
  }

  const callbackUrl = await requireFileInputValue('XID_PRODUCTION_ENTERPRISE_SSO_CALLBACK_URL')
  const connectionId =
    (await readInputValue('XID_PRODUCTION_ENTERPRISE_SSO_CONNECTION_ID')) ??
    inferOidcConnectionId(callbackUrl)
  if (connectionId !== inferOidcConnectionId(callbackUrl)) {
    throw new Error('enterprise SSO connection id does not match callback URL')
  }
  const cookie = await fetchOidcCallback(callbackUrl)
  await verifyEnterpriseSession(cookie, connectionId, expectedOrgId)
  await recordProductionEvidence(
    EVIDENCE_KEYS.enterpriseSsoFull,
    EVIDENCE_MARKERS.enterpriseSsoFull,
    preSmokeContext,
  )
  printResult('PASS', 'production evidence recorded', EVIDENCE_KEYS.enterpriseSsoFull)
}
