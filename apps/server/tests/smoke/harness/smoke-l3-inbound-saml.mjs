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

const connectionId = 'conn_l3_inbound_saml'
const fakeIdpEntityId = 'https://fake-idp.example.com/metadata'

async function prepareInboundConnection(fixture) {
  const certificate = process.env.XID_L3_SAML_IDP_CERT_B64
  if (!certificate) throw new Error('XID_L3_SAML_IDP_CERT_B64 missing')
  const now = Date.now()
  await d1(
    `INSERT INTO sso_connections (id, tenant_id, org_id, protocol, idp_entity_id, idp_sso_url, idp_slo_url, idp_metadata_url, idp_certificates, oidc_client_id, oidc_discovery_url, want_authn_response_signed, want_assertions_signed, attribute_mapping, role_mapping, jit_enabled, relay_state_url, status, created_at, updated_at) VALUES (${sqlString(connectionId)}, ${sqlString(fixture.tenantId)}, ${sqlString(fixture.tenantId)}, 'saml', ${sqlString(fakeIdpEntityId)}, ${sqlString(`${baseUrl}/test/fake-idp/saml/sso`)}, NULL, ${sqlString(`${baseUrl}/test/fake-idp/saml/metadata`)}, ${sqlJson([certificate])}, NULL, NULL, 1, 1, ${sqlJson({ email: 'email', firstName: 'firstName', lastName: 'lastName', idpId: 'nameID', _xidPreset: 'fake-idp' })}, ${sqlJson({})}, 1, NULL, 'active', ${now}, ${now}) ON CONFLICT(org_id) DO UPDATE SET id = excluded.id, protocol = excluded.protocol, idp_entity_id = excluded.idp_entity_id, idp_sso_url = excluded.idp_sso_url, idp_metadata_url = excluded.idp_metadata_url, idp_certificates = excluded.idp_certificates, attribute_mapping = excluded.attribute_mapping, jit_enabled = excluded.jit_enabled, status = 'active', updated_at = excluded.updated_at;`,
    'upsert inbound SAML connection',
  )
}

async function enableInboundSamlPolicy(fixture) {
  const rows = await d1(
    `SELECT private_metadata FROM organizations WHERE id = ${sqlString(fixture.tenantId)} LIMIT 1;`,
    'load inbound SAML policy',
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
    'enable inbound SAML policy',
  )
  return originalMetadata
}

async function restoreInboundSamlPolicy(fixture, originalMetadata) {
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(originalMetadata)}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'restore inbound SAML policy',
  )
}

async function cleanupInboundSamlConnection(fixture) {
  await d1(
    `DELETE FROM sso_connections WHERE tenant_id = ${sqlString(fixture.tenantId)} AND id = ${sqlString(connectionId)};`,
    'cleanup inbound SAML connection',
  )
}

function hiddenInput(html, name) {
  const pattern = new RegExp(`name="${name}" value="([^"]*)"`)
  return pattern.exec(html)?.[1] ?? null
}

async function runInboundSamlFlow() {
  const metadata = await fetchText(`/sso/saml/${connectionId}/metadata`)
  if (metadata.res.status !== 200) {
    throw new Error(`SP metadata failed http=${metadata.res.status}`)
  }
  printResult('PASS', 'inbound SAML SP metadata', `http=${metadata.res.status}`)

  const loginStart = await fetchText(`/sso/saml/${connectionId}/login?RelayState=/console`)
  if (loginStart.res.status !== 302) {
    throw new Error(`SP-initiated login failed http=${loginStart.res.status}`)
  }
  const idpLocation = loginStart.res.headers.get('location') ?? ''
  if (!idpLocation.includes('/test/fake-idp/saml/sso')) {
    throw new Error(`login redirect missing fake IdP: ${idpLocation}`)
  }
  printResult('PASS', 'SP-initiated login redirect', idpLocation)

  const idpRes = await fetch(idpLocation, { redirect: 'manual' })
  const idpHtml = await idpRes.text()
  if (idpRes.status !== 200) {
    throw new Error(`fake IdP failed http=${idpRes.status} body=${idpHtml}`)
  }
  const action = /<form method="post" action="([^"]+)"/.exec(idpHtml)?.[1]
  const samlResponse = hiddenInput(idpHtml, 'SAMLResponse')
  if (!action || !samlResponse) throw new Error('fake IdP POST form missing')
  const acs = await fetch(action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: '/console' }),
    redirect: 'manual',
  })
  if (acs.status !== 302) {
    throw new Error(`inbound SAML ACS failed http=${acs.status} body=${await acs.text()}`)
  }
  const sessionCookie = acs.headers.get('set-cookie') ?? ''
  if (!sessionCookie.includes('__Host-xid.rt.')) {
    throw new Error('inbound SAML ACS did not issue session cookie')
  }
  printResult('PASS', 'inbound SAML ACS session', `http=${acs.status}`)
}

export async function runL3InboundSamlSmoke() {
  await applyLocalMigrations()
  await ensureDevServerHealthy()
  await ensureSeeded()
  const fixture = await loadAdminFixture()
  const originalMetadata = await enableInboundSamlPolicy(fixture)
  try {
    await prepareInboundConnection(fixture)
    await runInboundSamlFlow()
  } finally {
    try {
      await restoreInboundSamlPolicy(fixture, originalMetadata)
    } finally {
      await cleanupInboundSamlConnection(fixture)
    }
  }
}
