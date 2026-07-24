#!/usr/bin/env node

import {
  adminPassword,
  applyLocalMigrations,
  d1,
  ensureDevServerHealthy,
  ensureSeeded,
  fetchText,
  hashPassword,
  loadAdminFixture,
  login,
  parseDevVars,
  passwordReuseTag,
  printResult,
  sqlJson,
  sqlString,
} from './smoke-l3-shared.mjs'

const deviceClientId = 'client_l3_device'
const deviceClientSecret = 'dev_sec_l3_device'

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

async function prepareDeviceClient(fixture) {
  const now = Date.now()
  const secretHash = await sha256Hex(deviceClientSecret)
  await d1(
    `INSERT INTO applications (id, tenant_id, project_id, client_id, client_secret_hash, client_type, token_endpoint_auth_method, redirect_uris, post_logout_redirect_uris, allowed_grant_types, allowed_response_types, allowed_scopes, require_pkce, dpop_bound_access_tokens, access_token_format, access_token_ttl_sec, id_token_signed_alg, first_party, require_org_context, custom_claims_config, status, created_at, updated_at) VALUES ('app_l3_device', ${sqlString(fixture.tenantId)}, NULL, ${sqlString(deviceClientId)}, ${sqlString(secretHash)}, 'confidential', 'client_secret_basic', ${sqlJson([])}, ${sqlJson([])}, ${sqlJson(['urn:ietf:params:oauth:grant-type:device_code'])}, ${sqlJson(['code'])}, ${sqlJson(['openid', 'profile', 'email'])}, 0, 0, 'jwt', 3600, 'ES256', 1, 0, '{}', 'active', ${now}, ${now}) ON CONFLICT(client_id) DO UPDATE SET tenant_id = excluded.tenant_id, client_secret_hash = excluded.client_secret_hash, allowed_grant_types = excluded.allowed_grant_types, first_party = excluded.first_party, status = 'active', updated_at = excluded.updated_at;`,
    'upsert device flow client',
  )
}

async function prepareDevicePassword(fixture) {
  const rows = await d1(
    `SELECT private_metadata FROM organizations WHERE id = ${sqlString(fixture.tenantId)} LIMIT 1;`,
    'load device flow password policy',
  )
  const metadata = JSON.parse(rows[0]?.private_metadata || '{}')
  const originalMetadata = JSON.stringify(metadata)
  metadata.hostedAuth = {
    ...(metadata.hostedAuth ?? {}),
    identifierMode: 'email',
    password: {
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
  }
  const vars = parseDevVars()
  const passwordHash = await hashPassword(adminPassword, vars.PEPPER)
  const reuseTag = await passwordReuseTag(adminPassword, vars.PEPPER)
  const now = Date.now()
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${now} WHERE id = ${sqlString(fixture.tenantId)};`,
    'enable device flow password policy',
  )
  await d1(
    `INSERT INTO passwords (id, tenant_id, user_id, hash, algo, pepper_version, reuse_tag, breached, created_at, updated_at) VALUES (${sqlString(`pw_l3_device_${fixture.userId}`)}, ${sqlString(fixture.tenantId)}, ${sqlString(fixture.userId)}, ${sqlString(passwordHash.hash)}, ${sqlString(passwordHash.algo)}, ${passwordHash.pepperVersion}, ${sqlString(reuseTag)}, 0, ${now}, ${now}) ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, algo = excluded.algo, pepper_version = excluded.pepper_version, reuse_tag = excluded.reuse_tag, updated_at = excluded.updated_at;`,
    'upsert device flow password',
  )
  return { originalMetadata }
}

async function cleanupDevicePassword(fixture, passwordFixture) {
  if (!passwordFixture) return
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(passwordFixture.originalMetadata)}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'restore device flow password policy',
  )
  await d1(
    `DELETE FROM passwords WHERE id = ${sqlString(`pw_l3_device_${fixture.userId}`)};`,
    'cleanup device flow password',
  )
}

export async function runL3DeviceFlowSmoke() {
  await applyLocalMigrations()
  await ensureDevServerHealthy()
  await ensureSeeded()
  const fixture = await loadAdminFixture()
  const passwordFixture = await prepareDevicePassword(fixture)
  try {
    await prepareDeviceClient(fixture)
    const creds = btoa(`${deviceClientId}:${deviceClientSecret}`)
    const device = await fetchText('/device_authorization', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${creds}`,
      },
      body: new URLSearchParams({ scope: 'openid profile email' }),
    })
    if (device.res.status !== 200) {
      throw new Error(`/device_authorization failed http=${device.res.status} body=${device.text}`)
    }
    const deviceJson = JSON.parse(device.text)
    if (!deviceJson.device_code || !deviceJson.user_code) {
      throw new Error(`device_authorization missing codes: ${device.text}`)
    }
    printResult('PASS', 'device authorization', `user_code=${deviceJson.user_code}`)

    const cookie = await login()
    const lookup = await fetchText(
      `/auth/device-activation?user_code=${encodeURIComponent(deviceJson.user_code)}`,
      { cookie },
    )
    if (lookup.res.status !== 200) {
      throw new Error(`device activation lookup failed http=${lookup.res.status}`)
    }
    printResult('PASS', 'device activation lookup', `http=${lookup.res.status}`)

    const activatePage = await fetchText(
      `/activate?user_code=${encodeURIComponent(deviceJson.user_code)}`,
      { cookie },
    )
    if (activatePage.res.status !== 200) {
      throw new Error(`activate page failed http=${activatePage.res.status}`)
    }
    if (!activatePage.text.includes('id="root"')) {
      throw new Error('activate page missing SPA root mount')
    }
    printResult('PASS', 'device activate page', `http=${activatePage.res.status}`)

    const approve = await fetchText('/auth/device-activation', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: deviceJson.user_code, approved: true }),
    })
    if (approve.res.status !== 200) {
      throw new Error(
        `device activation approve failed http=${approve.res.status} body=${approve.text}`,
      )
    }
    printResult('PASS', 'device activation approve', `http=${approve.res.status}`)

    const token = await fetchText('/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${creds}`,
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceJson.device_code,
        client_id: deviceClientId,
      }),
    })
    if (token.res.status !== 200) {
      throw new Error(`/token device_code failed http=${token.res.status} body=${token.text}`)
    }
    const tokenJson = JSON.parse(token.text)
    if (!tokenJson.access_token) throw new Error(`device token missing access_token: ${token.text}`)
    printResult('PASS', 'device flow token', `token_type=${tokenJson.token_type}`)
  } finally {
    await cleanupDevicePassword(fixture, passwordFixture)
  }
}
