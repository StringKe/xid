#!/usr/bin/env node

import {
  applyLocalMigrations,
  baseUrl,
  d1,
  ensureDevServerHealthy,
  ensureSeeded,
  fetchText,
  loadAdminFixture,
  printResult,
  sqlJson,
  sqlString,
} from './smoke-l3-shared.mjs'

const connectionId = 'conn_l3_legacy'

const legacyConnections = {
  ldap: {
    protocol: 'ldap',
    mapping: {
      _legacy: {
        ldapGatewayUrl: `${baseUrl}/test-harness/fake-ldap/bind`,
      },
    },
  },
  wsfed: {
    protocol: 'wsfed',
    idpSsoUrl: `${baseUrl}/test-harness/fake-wsfed/login`,
    mapping: {
      _legacy: {
        wsfedRealm: `${baseUrl}`,
        wsfedReplyUrl: `${baseUrl}/sso/wsfed/${connectionId}/callback`,
      },
    },
  },
  swa: {
    protocol: 'swa',
    mapping: {
      _legacy: {
        swaTargetUrl: 'https://app.example.com/login',
      },
    },
  },
  header: {
    protocol: 'header',
    mapping: {
      _legacy: {
        trustedProxySecret: 'l3-proxy-secret',
        headerEmail: 'X-Remote-Email',
        headerUser: 'X-Remote-User',
      },
    },
  },
}

async function prepareLegacyConnection(fixture, connection) {
  const now = Date.now()
  const idpSsoUrl = connection.idpSsoUrl ? sqlString(connection.idpSsoUrl) : 'NULL'
  await d1(
    `INSERT INTO sso_connections (id, tenant_id, org_id, protocol, idp_entity_id, idp_sso_url, idp_slo_url, idp_metadata_url, idp_certificates, oidc_client_id, oidc_discovery_url, want_authn_response_signed, want_assertions_signed, attribute_mapping, role_mapping, jit_enabled, relay_state_url, status, created_at, updated_at) VALUES (${sqlString(connectionId)}, ${sqlString(fixture.tenantId)}, ${sqlString(fixture.tenantId)}, ${sqlString(connection.protocol)}, NULL, ${idpSsoUrl}, NULL, NULL, '[]', NULL, NULL, 1, 1, ${sqlJson(connection.mapping)}, ${sqlJson({})}, 1, NULL, 'active', ${now}, ${now}) ON CONFLICT(org_id) DO UPDATE SET id = excluded.id, tenant_id = excluded.tenant_id, protocol = excluded.protocol, idp_sso_url = excluded.idp_sso_url, attribute_mapping = excluded.attribute_mapping, status = 'active', updated_at = excluded.updated_at;`,
    `upsert ${connection.protocol} legacy connection`,
  )
}

async function enableLegacyEnterpriseSso(fixture) {
  const rows = await d1(
    `SELECT private_metadata FROM organizations WHERE id = ${sqlString(fixture.tenantId)} LIMIT 1;`,
    'load legacy enterprise policy',
  )
  const metadata = JSON.parse(rows[0]?.private_metadata || '{}')
  const originalMetadata = JSON.stringify(metadata)
  metadata.hostedAuth = {
    ...(metadata.hostedAuth ?? {}),
    enterpriseSso: {
      enabled: true,
      allowLogin: true,
      allowJitUserCreation: true,
      domainDiscovery: false,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    },
  }
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'enable legacy enterprise policy',
  )
  return originalMetadata
}

async function restoreLegacyEnterpriseSso(fixture, originalMetadata) {
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(originalMetadata)}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'restore legacy enterprise policy',
  )
}

async function cleanupLegacyConnection(fixture) {
  await d1(
    `DELETE FROM sso_connections WHERE tenant_id = ${sqlString(fixture.tenantId)} AND id = ${sqlString(connectionId)};`,
    'cleanup legacy connection',
  )
}

function hasSessionCookie(res) {
  const cookie = res.headers.get('set-cookie') ?? ''
  return cookie.includes('__Host-xid.rt.')
}

async function runLegacyFlows(fixture) {
  await prepareLegacyConnection(fixture, legacyConnections.ldap)

  const ldap = await fetchText(`/sso/ldap/${connectionId}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ldap.user@example.com', password: 'ldap-pass' }),
  })
  if (ldap.res.status !== 302 || !hasSessionCookie(ldap.res)) {
    throw new Error(`LDAP login failed http=${ldap.res.status} body=${ldap.text}`)
  }
  printResult('PASS', 'legacy LDAP login', `http=${ldap.res.status}`)

  await prepareLegacyConnection(fixture, legacyConnections.wsfed)
  const wsfedLogin = await fetchText(`/sso/wsfed/${connectionId}/login`)
  if (wsfedLogin.res.status !== 302) {
    throw new Error(`WS-Fed login failed http=${wsfedLogin.res.status}`)
  }
  const idpLocation = wsfedLogin.res.headers.get('location') ?? ''
  const idpRes = await fetch(idpLocation, { redirect: 'manual' })
  if (idpRes.status !== 302) {
    throw new Error(`fake WS-Fed IdP failed http=${idpRes.status}`)
  }
  const callbackLocation = idpRes.headers.get('location') ?? ''
  const wsfedCallback = await fetch(callbackLocation, { redirect: 'manual' })
  const wsfedCallbackBody = await wsfedCallback.text()
  if (wsfedCallback.status !== 302 || !hasSessionCookie(wsfedCallback)) {
    throw new Error(`WS-Fed callback failed http=${wsfedCallback.status} body=${wsfedCallbackBody}`)
  }
  printResult('PASS', 'legacy WS-Fed callback', `http=${wsfedCallback.status}`)

  await prepareLegacyConnection(fixture, legacyConnections.swa)
  const swa = await fetchText(`/sso/swa/${connectionId}/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'swa.user@example.com', password: 'swa-pass' }),
  })
  if (swa.res.status !== 302 || !hasSessionCookie(swa.res)) {
    throw new Error(`SWA authenticate failed http=${swa.res.status}`)
  }
  printResult('PASS', 'legacy SWA authenticate', `http=${swa.res.status}`)

  await prepareLegacyConnection(fixture, legacyConnections.header)
  const header = await fetchText(`/sso/header/${connectionId}/authenticate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-remote-user': 'header.user@example.com',
      'x-remote-email': 'header.user@example.com',
      'x-trusted-proxy-secret': 'l3-proxy-secret',
    },
  })
  if (header.res.status !== 302 || !hasSessionCookie(header.res)) {
    throw new Error(`header SSO failed http=${header.res.status}`)
  }
  printResult('PASS', 'legacy header SSO authenticate', `http=${header.res.status}`)
}

export async function runL3InboundLegacySmoke() {
  await applyLocalMigrations()
  await ensureDevServerHealthy()
  await ensureSeeded()
  const fixture = await loadAdminFixture()
  const originalMetadata = await enableLegacyEnterpriseSso(fixture)
  try {
    await runLegacyFlows(fixture)
  } finally {
    try {
      await restoreLegacyEnterpriseSso(fixture, originalMetadata)
    } finally {
      await cleanupLegacyConnection(fixture)
    }
  }
}
