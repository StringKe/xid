#!/usr/bin/env node

import {
  baseUrl,
  collectSetCookie,
  d1,
  fetchText,
  parseJson,
  requireFileInputValue,
  printResult,
  readInputValue,
  registerCleanupSignalHandlers,
  runCleanupSteps,
  sha256Hex,
  sqlString,
} from './production-auth.mjs'
import {
  beginProductionEvidence,
  EVIDENCE_KEYS,
  EVIDENCE_MARKERS,
  recordProductionEvidence,
} from './production-evidence.mjs'

function inferProvider(callbackUrl) {
  const url = new URL(callbackUrl)
  const match = url.pathname.match(/^\/auth\/([^/]+)\/callback$/u)
  if (!match?.[1]) throw new Error('social callback URL must target /auth/{provider}/callback')
  return match[1]
}

async function fetchCallback(callbackUrl) {
  const url = new URL(callbackUrl)
  if (url.origin !== baseUrl) throw new Error('social callback URL origin mismatch')
  const { res, text } = await fetchText(`${url.pathname}${url.search}`, {
    headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
  })
  if (res.status !== 302) {
    throw new Error(
      `social callback did not redirect http=${res.status} body=${text.slice(0, 120)}`,
    )
  }
  const location = res.headers.get('location') ?? ''
  if (!location.startsWith(`${baseUrl}/console`) && !location.startsWith('/console')) {
    throw new Error('social callback did not redirect to console')
  }
  const cookie = collectSetCookie(res)
  if (!cookie.includes('__Host-xid.rt.')) {
    throw new Error('social callback did not set session cookie')
  }
  return cookie
}

async function verifySessionCookie(cookie, provider, expectedOrgId) {
  const { res, text } = await fetchText('/v1/me', { cookie })
  if (res.status !== 200) throw new Error(`/v1/me failed after social callback http=${res.status}`)
  const body = parseJson(text, '/v1/me social')
  if (!body?.user?.id) throw new Error('/v1/me social user id missing')
  if (!body?.activeOrg?.id) throw new Error('/v1/me social activeOrg missing')
  if (expectedOrgId && body.activeOrg.id !== expectedOrgId) {
    throw new Error('/v1/me social activeOrg mismatch')
  }
  const sessionCookie = cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('__Host-xid.rt.'))
  const refreshToken = sessionCookie?.split('=').slice(1).join('=')
  if (!refreshToken) throw new Error('social session cookie value missing')
  const refreshTokenHash = await sha256Hex(refreshToken)
  const rows = await d1(
    `
SELECT id, tenant_id, user_id, active_org_id, status
FROM sessions
WHERE refresh_token_hash = ${sqlString(refreshTokenHash)}
LIMIT 1;
`,
    'load social oauth session',
  )
  const session = rows[0]
  if (!session) throw new Error('social oauth session was not written to production D1')
  if (session.status !== 'active') throw new Error('social oauth session is not active')
  if (session.user_id !== body.user.id) throw new Error('social oauth session user mismatch')
  if (session.active_org_id !== body.activeOrg.id) {
    throw new Error('social oauth session active organization mismatch')
  }
  const identityRows = await d1(
    `
SELECT COUNT(*) AS count
FROM user_identities
WHERE tenant_id = ${sqlString(body.activeOrg.id)}
  AND user_id = ${sqlString(body.user.id)}
  AND identity_type = 'oauth'
  AND provider = ${sqlString(provider)}
  AND revoked_at IS NULL;
`,
    'verify social oauth identity',
  )
  if (Number(identityRows[0]?.count ?? 0) < 1) {
    throw new Error('social oauth identity was not linked in production D1')
  }
  printResult('PASS', 'social oauth provider callback', `provider=${provider}`)
  printResult('PASS', 'social oauth cookie', `org=${body.activeOrg.id}`)
  printResult('PASS', 'social oauth me active organization', `org=${body.activeOrg.id}`)
}

// provider 回调建出来的 session 是本 harness 唯一自己造出来的实体。它挂在真实用户上、
// 不带任何 smoke 前缀,共享扫除永远看不见它 -- 不在这里登出就没有第二个机制会收。
async function signOutSocialOauthSession(cookie) {
  if (!cookie) return
  const { res, text } = await fetchText('/auth/sign-out', { method: 'POST', cookie })
  if (res.status !== 200) {
    throw new Error(`social oauth sign out failed http=${res.status} body=${text}`)
  }
  const after = await fetchText('/v1/me', { cookie })
  if (after.res.status === 200) {
    throw new Error('social oauth session still authenticates after sign out')
  }
  printResult('PASS', 'social oauth sign out', `http=${res.status} me=${after.res.status}`)
}

export async function runProductionSocialOauthSmoke() {
  const preSmokeContext = await beginProductionEvidence()
  const callbackUrl = await requireFileInputValue('XID_PRODUCTION_SOCIAL_OAUTH_CALLBACK_URL')
  const expectedProvider =
    (await readInputValue('XID_PRODUCTION_SOCIAL_OAUTH_PROVIDER')) ?? inferProvider(callbackUrl)
  const inferredProvider = inferProvider(callbackUrl)
  if (expectedProvider !== inferredProvider) {
    throw new Error('social oauth provider does not match callback URL')
  }
  const expectedOrgId = await readInputValue('XID_PRODUCTION_SOCIAL_OAUTH_ORGANIZATION_ID')

  let cookie = null
  let primaryError = null
  const unregisterSignals = registerCleanupSignalHandlers(() => signOutSocialOauthSession(cookie))
  try {
    cookie = await fetchCallback(callbackUrl)
    await verifySessionCookie(cookie, expectedProvider, expectedOrgId)
    await recordProductionEvidence(
      EVIDENCE_KEYS.socialOauthFull,
      EVIDENCE_MARKERS.socialOauthFull,
      preSmokeContext,
    )
    printResult('PASS', 'production evidence recorded', EVIDENCE_KEYS.socialOauthFull)
  } catch (error) {
    primaryError = error
  } finally {
    unregisterSignals()
    const { failures } = await runCleanupSteps([
      { name: 'social oauth session sign out', run: () => signOutSocialOauthSession(cookie) },
    ])
    // 在 finally 里直接 throw:清理失败必须判红,且不依赖 try 里有没有提前 return。
    if (failures.length > 0 && !primaryError) {
      throw new Error(
        `social oauth cleanup failed: ${failures.map((failure) => failure.name).join(', ')}`,
      )
    }
  }
  if (primaryError) throw primaryError
}
