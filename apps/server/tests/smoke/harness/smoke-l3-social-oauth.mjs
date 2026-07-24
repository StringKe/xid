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
  sqlString,
} from './smoke-l3-shared.mjs'

const providers = ['google', 'github_emu', 'microsoft', 'apple']

async function enableFakeSocialProviders(fixture) {
  const rows = await d1(
    `SELECT private_metadata FROM organizations WHERE id = ${sqlString(fixture.tenantId)} LIMIT 1;`,
    'load org metadata',
  )
  const metadata = JSON.parse(rows[0]?.private_metadata || '{}')
  metadata.socialProviders = metadata.socialProviders ?? {}
  for (const provider of providers) {
    const issuer = baseUrl
    metadata.socialProviders[provider] = {
      enabled: true,
      allowLogin: true,
      allowUserCreation: true,
      requireVerifiedEmail: false,
      clientId: 'fake-social-client',
      clientSecretRef: 'PEPPER',
      authorizationEndpoint: `${issuer}/test/fake-social/${provider}/authorize`,
      tokenEndpoint: `${issuer}/test/fake-social/${provider}/token`,
      userInfoEndpoint: `${issuer}/test/fake-social/${provider}/userinfo`,
      issuer: `${issuer}/test/fake-social/${provider}`,
      jwksUri: `${issuer}/test/fake-social/${provider}/jwks`,
      scopes: ['openid', 'email', 'profile'],
      usesPkce: true,
      redirectUris: ['/console', '/account'],
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    }
  }
  const now = Date.now()
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${now} WHERE id = ${sqlString(fixture.tenantId)};`,
    'enable fake social providers',
  )
}

function parseFormPostHtml(html) {
  const action = /action="([^"]+)"/.exec(html)?.[1]
  const code = /name="code" value="([^"]+)"/.exec(html)?.[1]
  const state = /name="state" value="([^"]+)"/.exec(html)?.[1]
  if (!action || !code || !state) {
    throw new Error(`invalid form_post html: ${html}`)
  }
  return { action, code, state }
}

function absoluteUrl(pathOrUrl) {
  return pathOrUrl.startsWith('http') ? pathOrUrl : `${baseUrl}${pathOrUrl}`
}

async function completeSocialCallback(provider, authorizeLocation) {
  const authorizeRes = await fetch(absoluteUrl(authorizeLocation), { redirect: 'manual' })
  const authorizeText = await authorizeRes.text()

  if (provider === 'apple') {
    if (authorizeRes.status !== 200) {
      throw new Error(
        `${provider} fake authorize failed http=${authorizeRes.status} body=${authorizeText}`,
      )
    }
    const form = parseFormPostHtml(authorizeText)
    const actionUrl = new URL(form.action)
    const complete = await fetchText(`${actionUrl.pathname}${actionUrl.search}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: form.code, state: form.state }),
      redirect: 'manual',
    })
    return complete
  }

  const callbackLocation = authorizeRes.headers.get('location') ?? ''
  if (authorizeRes.status !== 302) {
    throw new Error(
      `${provider} fake authorize failed http=${authorizeRes.status} body=${authorizeText}`,
    )
  }
  if (
    !callbackLocation.includes(`/auth/${provider}/callback`) ||
    !callbackLocation.includes('code=')
  ) {
    throw new Error(`${provider} fake authorize missing callback: ${callbackLocation}`)
  }
  const callbackUrl = new URL(callbackLocation)
  return fetchText(`${callbackUrl.pathname}${callbackUrl.search}`, { redirect: 'manual' })
}

export async function runL3SocialOAuthSmoke() {
  await applyLocalMigrations()
  await ensureDevServerHealthy()
  await ensureSeeded()
  const fixture = await loadAdminFixture()
  await enableFakeSocialProviders(fixture)

  for (const provider of providers) {
    const start = await fetchText(`/auth/${provider}/authorize?continue=/console`)
    if (start.res.status !== 302) {
      throw new Error(
        `${provider} social authorize failed http=${start.res.status} body=${start.text}`,
      )
    }
    const location = start.res.headers.get('location') ?? ''
    if (!location.includes(`/test/fake-social/${provider}/authorize`)) {
      throw new Error(`${provider} authorize missing fake redirect: ${location}`)
    }

    const fakeAuthorizeUrl = new URL(location, baseUrl)
    const complete = await completeSocialCallback(
      provider,
      fakeAuthorizeUrl.pathname + fakeAuthorizeUrl.search,
    )
    if (complete.res.status !== 302) {
      throw new Error(
        `${provider} social callback failed http=${complete.res.status} body=${complete.text}`,
      )
    }
    const setCookie = complete.res.headers.get('set-cookie') ?? ''
    if (!setCookie.includes('__Host-xid.rt.')) {
      throw new Error(`${provider} social callback missing session cookie`)
    }
    printResult('PASS', `fake social oauth ${provider}`, `http=${complete.res.status}`)
  }
}
