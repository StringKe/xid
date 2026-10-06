#!/usr/bin/env node

// L3: an application authorization request that needs Hosted Auth returns to /authorize and
// finishes with a code exchange, for API callers, the SPA, and forced MFA enrollment.

import {
  applyLocalMigrations,
  baseUrl,
  collectSetCookie,
  d1,
  ensureDevServerHealthy,
  ensureSeeded,
  fetchText,
  hashPassword,
  loadAdminFixture,
  parseDevVars,
  passwordReuseTag,
  printResult,
  sqlJson,
  sqlString,
} from './smoke-l3-shared.mjs'
import { createServer } from 'node:http'
import { pollUntil } from './poll-until.mjs'
import { currentTotpCode, withChrome } from './smoke-l3-password-browser.mjs'

const clientId = 'client_l3_hosted_authz'
const applicationId = 'app_l3_hosted_authz'
const userId = 'user_l3_hosted_authz'
const userEmailId = 'email_l3_hosted_authz'
const userPhoneId = 'phone_l3_hosted_authz'
const userEmail = 'hosted-authz@localhost.test'
const userPhone = '+15557654321'
const userPassword = 'LocalL3HostedAuthz123!'
// 本地 RP 回调;浏览器必须真实落到 RP,才能证明 /authorize 走了整页导航。
let redirectUri = ''

async function startRelyingPartyServer() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('relying party callback')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  redirectUri = `http://127.0.0.1:${address.port}/callback`
  return { close: () => new Promise((resolve) => server.close(resolve)) }
}

function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

function parseJson(text, name) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} returned non-json body: ${text.slice(0, 200)}`)
  }
}

async function readOrganizationMetadata(tenantId) {
  const rows = await d1(
    `SELECT private_metadata FROM organizations WHERE id = ${sqlString(tenantId)} LIMIT 1;`,
    'load hosted authorize org metadata',
  )
  return JSON.parse(rows[0]?.private_metadata || '{}')
}

async function writeOrganizationMetadata(tenantId, metadata, name) {
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${Date.now()} WHERE id = ${sqlString(tenantId)};`,
    name,
  )
}

async function setHostedAuthPolicy(fixture, overrides) {
  const metadata = JSON.parse(fixture.originalMetadata)
  metadata.hostedAuth = {
    ...(metadata.hostedAuth ?? {}),
    identifierMode: 'email',
    requireVerifiedEmail: true,
    allowExistingUserLogin: true,
    password: {
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
    ...overrides.hostedAuth,
  }
  if (overrides.deliveryChannels) metadata.deliveryChannels = overrides.deliveryChannels
  await writeOrganizationMetadata(fixture.tenantId, metadata, 'set hosted authorize policy')
}

async function setOrganizationMfaPolicy(fixture, mfaPolicy) {
  const now = Date.now()
  await d1(
    `INSERT INTO org_policies (id, tenant_id, org_id, mfa_policy, force_sso, allow_password_login, created_at, updated_at) VALUES ('orgpol_l3_hosted_authz', ${sqlString(fixture.tenantId)}, ${sqlString(fixture.tenantId)}, ${mfaPolicy === null ? 'NULL' : sqlString(mfaPolicy)}, 0, 1, ${now}, ${now}) ON CONFLICT(org_id) DO UPDATE SET mfa_policy = excluded.mfa_policy, updated_at = excluded.updated_at;`,
    `set organization mfa policy ${mfaPolicy}`,
  )
}

async function deleteHostedAuthorizeUser(tenantId) {
  for (const table of [
    'sessions',
    'mfa_factors',
    'backup_codes',
    'passwords',
    'memberships',
    'oauth_consents',
    'user_phones',
    'user_emails',
  ]) {
    await d1(
      `DELETE FROM ${table} WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      `cleanup hosted authorize ${table}`,
    )
  }
  await d1(
    `DELETE FROM authorization_codes WHERE tenant_id = ${sqlString(tenantId)} AND client_id = ${sqlString(clientId)};`,
    'cleanup hosted authorize codes',
  )
  await d1(
    `DELETE FROM users WHERE tenant_id = ${sqlString(tenantId)} AND id = ${sqlString(userId)};`,
    'cleanup hosted authorize user',
  )
}

async function prepareFixture() {
  const vars = parseDevVars()
  const admin = await loadAdminFixture()
  const tenantId = admin.tenantId
  const originalMetadata = JSON.stringify(await readOrganizationMetadata(tenantId))
  const policyRows = await d1(
    `SELECT id, mfa_policy FROM org_policies WHERE tenant_id = ${sqlString(tenantId)} AND org_id = ${sqlString(tenantId)} LIMIT 1;`,
    'load organization mfa policy',
  )
  const fixture = {
    tenantId,
    originalMetadata,
    originalPolicy: policyRows[0] ?? null,
  }
  await deleteHostedAuthorizeUser(tenantId)

  const now = Date.now()
  const passwordHash = await hashPassword(userPassword, vars.PEPPER)
  const reuseTag = await passwordReuseTag(userPassword, vars.PEPPER)
  await d1(
    `INSERT INTO users (id, tenant_id, username, external_id, primary_email_id, first_name, last_name, display_name, public_metadata, private_metadata, unsafe_metadata, custom_attributes, status, password_change_required, is_new_user, profile_completion_status, failed_login_count, provisioned_by, deleted_at, created_at, updated_at) VALUES (${sqlString(userId)}, ${sqlString(tenantId)}, NULL, NULL, ${sqlString(userEmailId)}, 'Hosted', 'Authorize', 'Hosted Authorize', '{}', '{}', '{}', '{}', 'active', 0, 0, 'complete', 0, 'l3-hosted-authorize', NULL, ${now}, ${now});`,
    'insert hosted authorize user',
  )
  await d1(
    `INSERT INTO user_emails (id, tenant_id, user_id, email, verified, verification_status, is_primary, verified_at, created_at, updated_at) VALUES (${sqlString(userEmailId)}, ${sqlString(tenantId)}, ${sqlString(userId)}, ${sqlString(userEmail)}, 1, 'verified', 1, ${now}, ${now}, ${now});`,
    'insert hosted authorize email',
  )
  await d1(
    `INSERT INTO passwords (id, tenant_id, user_id, hash, algo, pepper_version, reuse_tag, breached, created_at, updated_at) VALUES ('pw_l3_hosted_authz', ${sqlString(tenantId)}, ${sqlString(userId)}, ${sqlString(passwordHash.hash)}, ${sqlString(passwordHash.algo)}, ${passwordHash.pepperVersion}, ${sqlString(reuseTag)}, 0, ${now}, ${now});`,
    'insert hosted authorize password',
  )
  await d1(
    `INSERT INTO memberships (id, tenant_id, org_id, user_id, role, membership_type, status, is_managed, joined_at, created_at, updated_at) VALUES ('mem_l3_hosted_authz', ${sqlString(tenantId)}, ${sqlString(tenantId)}, ${sqlString(userId)}, 'member', 'member', 'active', 0, ${now}, ${now}, ${now});`,
    'insert hosted authorize membership',
  )
  await d1(
    `INSERT INTO applications (id, tenant_id, project_id, client_id, client_secret_hash, client_type, token_endpoint_auth_method, redirect_uris, post_logout_redirect_uris, allowed_grant_types, allowed_response_types, allowed_scopes, require_pkce, dpop_bound_access_tokens, access_token_format, access_token_ttl_sec, id_token_signed_alg, first_party, require_org_context, custom_claims_config, status, created_at, updated_at) VALUES (${sqlString(applicationId)}, ${sqlString(tenantId)}, NULL, ${sqlString(clientId)}, NULL, 'public', 'none', ${sqlJson([redirectUri])}, ${sqlJson([])}, ${sqlJson(['authorization_code'])}, ${sqlJson(['code'])}, ${sqlJson(['openid', 'profile', 'email'])}, 1, 0, 'jwt', 3600, 'ES256', 1, 0, '{}', 'active', ${now}, ${now}) ON CONFLICT(client_id) DO UPDATE SET tenant_id = excluded.tenant_id, redirect_uris = excluded.redirect_uris, allowed_grant_types = excluded.allowed_grant_types, allowed_response_types = excluded.allowed_response_types, allowed_scopes = excluded.allowed_scopes, require_pkce = 1, dpop_bound_access_tokens = 0, first_party = 1, status = 'active', updated_at = excluded.updated_at;`,
    'upsert hosted authorize application',
  )
  await setHostedAuthPolicy(fixture, {})
  await setOrganizationMfaPolicy(fixture, 'optional')
  printResult('PASS', 'hosted authorize fixture', `org=${tenantId} client=${clientId}`)
  return fixture
}

async function restoreFixture(fixture) {
  if (!fixture) return
  await writeOrganizationMetadata(
    fixture.tenantId,
    JSON.parse(fixture.originalMetadata),
    'restore hosted authorize org metadata',
  )
  if (fixture.originalPolicy) {
    await d1(
      `UPDATE org_policies SET mfa_policy = ${fixture.originalPolicy.mfa_policy === null ? 'NULL' : sqlString(fixture.originalPolicy.mfa_policy)}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.originalPolicy.id)};`,
      'restore organization mfa policy',
    )
  } else {
    await d1(
      `DELETE FROM org_policies WHERE id = 'orgpol_l3_hosted_authz';`,
      'remove hosted authorize mfa policy',
    )
  }
  await deleteHostedAuthorizeUser(fixture.tenantId)
  await d1(
    `DELETE FROM applications WHERE tenant_id = ${sqlString(fixture.tenantId)} AND client_id = ${sqlString(clientId)};`,
    'cleanup hosted authorize application',
  )
  printResult('PASS', 'restore hosted authorize fixture')
}

async function newAuthorizationRequest(label) {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  )
  const state = `st_l3_${label}`
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid email',
    state,
    nonce: `nonce_l3_${label}`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return { verifier, state, path: `/authorize?${params.toString()}` }
}

async function exchangeCode(callbackUrl, authorization, label) {
  const url = new URL(callbackUrl)
  if (`${url.origin}${url.pathname}` !== redirectUri) {
    throw new Error(`${label} did not return to the application: ${callbackUrl}`)
  }
  const code = url.searchParams.get('code')
  if (!code) throw new Error(`${label} callback missing code: ${callbackUrl}`)
  if (url.searchParams.get('state') !== authorization.state) {
    throw new Error(`${label} state mismatch: ${callbackUrl}`)
  }
  const token = await fetchText('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: authorization.verifier,
    }),
  })
  if (token.res.status !== 200) {
    throw new Error(`${label} /token failed http=${token.res.status} body=${token.text}`)
  }
  const body = parseJson(token.text, `${label} /token`)
  if (typeof body.access_token !== 'string' || typeof body.id_token !== 'string') {
    throw new Error(`${label} /token missing tokens: ${token.text}`)
  }
  printResult('PASS', `${label} code -> token`, `type=${body.token_type}`)
}

// Unauthenticated /authorize parks the request and sends the browser to Hosted Auth.
async function parkAuthorization(authorization, label) {
  const parked = await fetchText(authorization.path)
  if (parked.res.status !== 302) {
    throw new Error(`${label} /authorize http=${parked.res.status} body=${parked.text}`)
  }
  const signIn = new URL(parked.res.headers.get('location') ?? '', baseUrl)
  const authzRequestId = signIn.searchParams.get('authz_request_id')
  if (signIn.pathname !== '/sign-in' || !authzRequestId) {
    throw new Error(`${label} /authorize did not park at /sign-in: ${signIn}`)
  }
  if (signIn.searchParams.has('continue')) {
    throw new Error(`${label} /sign-in unexpectedly carries continue: ${signIn}`)
  }
  const resume = new URLSearchParams({ authz_request_id: authzRequestId, client_id: clientId })
  return `/authorize?${resume.toString()}`
}

async function resumeAuthorization(continuePath, cookie, authorization, label) {
  const resumed = await fetchText(continuePath, { cookie })
  if (resumed.res.status !== 302) {
    throw new Error(`${label} resume http=${resumed.res.status} body=${resumed.text}`)
  }
  await exchangeCode(
    new URL(resumed.res.headers.get('location') ?? '', baseUrl).toString(),
    authorization,
    label,
  )
}

async function postJson(path, body) {
  return await fetchText(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function verifyApiPasswordAuthorization() {
  const authorization = await newAuthorizationRequest('api_password')
  const continuePath = await parkAuthorization(authorization, 'api password')

  const missing = await postJson('/auth/password/sign-in', {
    identifier: userEmail,
    password: userPassword,
    clientId,
  })
  if (missing.res.status !== 400 || parseJson(missing.text, 'sign-in').code !== 'invalid_request') {
    throw new Error(
      `application sign-in without continue http=${missing.res.status} body=${missing.text}`,
    )
  }
  printResult('PASS', 'api password without continuation rejected', `http=${missing.res.status}`)

  const signIn = await postJson('/auth/password/sign-in', {
    identifier: userEmail,
    password: userPassword,
    clientId,
    continue: continuePath,
  })
  if (signIn.res.status !== 200) {
    throw new Error(`api password sign-in http=${signIn.res.status} body=${signIn.text}`)
  }
  const body = parseJson(signIn.text, 'api password sign-in')
  if (body.redirectUrl !== continuePath) {
    throw new Error(`api password redirect mismatch: ${signIn.text}`)
  }
  printResult('PASS', 'api password returns /authorize continuation')
  await resumeAuthorization(
    continuePath,
    collectSetCookie(signIn.res),
    authorization,
    'api password',
  )
}

// WhatsApp OTP 是登录方式而非 MFA 因子;不开 SMS 通道,避免已验证手机号触发 SMS MFA 门控。
async function verifyApiWhatsappOtpAuthorization(fixture) {
  const now = Date.now()
  await d1(
    `INSERT INTO user_phones (id, tenant_id, user_id, phone, verified, verification_status, is_primary, verified_at, created_at, updated_at) VALUES (${sqlString(userPhoneId)}, ${sqlString(fixture.tenantId)}, ${sqlString(userId)}, ${sqlString(userPhone)}, 1, 'verified', 1, ${now}, ${now}, ${now}) ON CONFLICT(tenant_id, phone) DO UPDATE SET user_id = excluded.user_id, verified = 1, verification_status = 'verified', updated_at = excluded.updated_at;`,
    'insert hosted authorize phone',
  )
  await setHostedAuthPolicy(fixture, {
    hostedAuth: {
      identifierMode: 'phone',
      whatsappOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
    },
    deliveryChannels: { whatsapp: { enabled: true, provider: 'test', from: 'XID' } },
  })
  try {
    const authorization = await newAuthorizationRequest('api_whatsapp_otp')
    const continuePath = await parkAuthorization(authorization, 'api whatsapp otp')
    const send = await postJson('/auth/otp/whatsapp/send', {
      phone: userPhone,
      clientId,
      continue: continuePath,
    })
    if (send.res.status !== 200) {
      throw new Error(`api whatsapp otp send http=${send.res.status} body=${send.text}`)
    }
    const captured = await pollUntil(
      async () => {
        const latest = await fetchText(
          `/test/otp/latest?recipient=${encodeURIComponent(userPhone)}`,
        )
        return latest.res.status === 200 ? parseJson(latest.text, 'otp capture') : null
      },
      { isReady: (value) => value !== null, label: 'hosted authorize whatsapp otp capture' },
    )
    const verify = await postJson('/auth/otp/whatsapp/verify', {
      phone: userPhone,
      code: captured.code,
      clientId,
      continue: continuePath,
    })
    if (verify.res.status !== 200) {
      throw new Error(`api whatsapp otp verify http=${verify.res.status} body=${verify.text}`)
    }
    if (parseJson(verify.text, 'api whatsapp otp verify').redirectUrl !== continuePath) {
      throw new Error(`api whatsapp otp redirect mismatch: ${verify.text}`)
    }
    printResult('PASS', 'api whatsapp otp returns /authorize continuation')
    await resumeAuthorization(
      continuePath,
      collectSetCookie(verify.res),
      authorization,
      'api whatsapp otp',
    )
  } finally {
    await d1(
      `DELETE FROM user_phones WHERE tenant_id = ${sqlString(fixture.tenantId)} AND id = ${sqlString(userPhoneId)};`,
      'remove hosted authorize phone',
    )
    await setHostedAuthPolicy(fixture, {})
  }
}

async function signInWithPasswordInBrowser(page, label) {
  try {
    await page.waitFor(
      () =>
        location.pathname === '/sign-in' &&
        document.body.innerText.includes('Password') &&
        document.body.innerText.includes('Sign in'),
      15_000,
      `${label} sign-in UI`,
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    throw new Error(`${error.message} at ${snapshot.href}: ${snapshot.text.slice(0, 400)}`, {
      cause: error,
    })
  }
  const passwordVisible = await page.evaluate(`(() => {
    const isVisible = (node) => {
      if (node.closest('[aria-hidden="true"],[inert]')) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0.1 &&
        rect.width > 0 &&
        rect.height > 0;
    };
    return Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible);
  })()`)
  if (passwordVisible !== true) await page.clickVisibleButton('Password')
  await page.setVisibleInputValue(
    'input[type="email"], input[autocomplete="email"], input[autocomplete="username"]',
    userEmail,
  )
  await page.setVisibleInputValue('input[type="password"]', userPassword)
  await page.clickVisibleButton('Sign in')
}

async function waitForApplicationCallback(page, label) {
  const source = `location.origin + location.pathname === ${JSON.stringify(redirectUri)} && new URLSearchParams(location.search).has('code')`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((await page.evaluate(source)) === true) return await page.evaluate('location.href')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const snapshot = await page.snapshot()
  throw new Error(
    `${label} never reached the application callback: ${snapshot.href} network=${JSON.stringify(page.authNetworkLog())}`,
  )
}

async function verifyBrowserPasswordAuthorization(page) {
  const authorization = await newAuthorizationRequest('browser_password')
  await page.navigate('/sign-in?locale=en')
  await page.setPreferredLocale('en')
  await page.clearSessionCookies()
  await page.navigate(authorization.path)
  await signInWithPasswordInBrowser(page, 'browser password')
  const callback = await waitForApplicationCallback(page, 'browser password')
  printResult('PASS', 'browser password resumes /authorize with a document navigation')
  await exchangeCode(callback, authorization, 'browser password')
}

async function verifyBrowserForcedMfaSetup(page, fixture) {
  await setOrganizationMfaPolicy(fixture, 'required')
  const authorization = await newAuthorizationRequest('browser_mfa_setup')
  await page.clearSessionCookies()
  await page.navigate(authorization.path)
  await signInWithPasswordInBrowser(page, 'browser mfa setup')
  await page.waitFor(
    () =>
      location.pathname === '/account/security' &&
      document.body.innerText.includes('Multi-factor authentication required') &&
      Array.from(document.querySelectorAll('button')).some(
        (item) => String(item.textContent || '').trim() === 'Add authenticator app',
      ),
    20_000,
    'forced mfa enrollment page',
  )
  const me = await page.browserMe()
  if (parseJson(me.body, '/v1/me pending').session?.status !== 'pending_mfa_setup') {
    throw new Error(`/v1/me did not report pending_mfa_setup: ${me.body}`)
  }
  printResult('PASS', 'pending_mfa_setup session reaches /account/security')

  await page.clickVisibleButton('Add authenticator app')
  await page.waitFor(
    () =>
      document.body.innerText
        .toLowerCase()
        .includes('scan this qr code with your authenticator app') &&
      document.querySelector('code')?.textContent?.trim().length > 0,
    15_000,
    'forced mfa totp setup panel',
  )
  const secret = await page.evaluate(
    `document.querySelector('code')?.textContent?.replace(/\\s+/g, '') || ''`,
  )
  await page.setVisibleInputValue(
    'input[autocomplete="one-time-code"], input[inputmode="numeric"]',
    await currentTotpCode(secret),
  )
  await page.submitVisibleFormContaining('Authenticator code')
  const callback = await waitForApplicationCallback(page, 'browser mfa setup')
  printResult('PASS', 'forced TOTP enrollment resumes /authorize')
  await exchangeCode(callback, authorization, 'browser mfa setup')
}

export async function runL3HostedAuthorizeSmoke() {
  let fixture
  const relyingParty = await startRelyingPartyServer()
  try {
    await applyLocalMigrations()
    await ensureDevServerHealthy()
    await ensureSeeded()
    fixture = await prepareFixture()
    await verifyApiPasswordAuthorization()
    await verifyApiWhatsappOtpAuthorization(fixture)
    await withChrome(async (page) => {
      await verifyBrowserPasswordAuthorization(page)
      await verifyBrowserForcedMfaSetup(page, fixture)
    })
    await restoreFixture(fixture)
  } catch (error) {
    try {
      await restoreFixture(fixture)
    } catch (restoreError) {
      printResult('FAIL', 'restore hosted authorize fixture', restoreError.message)
    }
    throw error
  } finally {
    await relyingParty.close()
  }
}
