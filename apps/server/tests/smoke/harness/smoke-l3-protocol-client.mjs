#!/usr/bin/env node

import { argon2id } from '@noble/hashes/argon2.js'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { deflateRawSync } from 'node:zlib'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { setNodeDependencies } from 'xml-core'
import { Application, Parse, SignedXml } from 'xmldsigjs'
import xpath from 'xpath'
import { parseD1Json } from './d1-json.mjs'
import { pollUntil } from './poll-until.mjs'
import { trimTrailingSlashes } from '../../../../../tests/helpers/url.mjs'

const DEFAULT_BASE_URL = 'http://localhost:5173'
const DEFAULT_PASSWORD = 'LocalL3Protocol123!'
const PACKAGE_MANAGER = process.env.XID_L3_PACKAGE_MANAGER ?? 'corepack'
const PACKAGE_MANAGER_ARGS = ['pnpm']
const baseUrl = trimTrailingSlashes(process.env.XID_L3_BASE_URL ?? DEFAULT_BASE_URL)
const adminEmail = (process.env.XID_L3_ADMIN_EMAIL ?? 'admin@localhost.test').toLowerCase()
const adminPassword = process.env.XID_L3_ADMIN_PASSWORD ?? DEFAULT_PASSWORD
const smokePersistPath = process.env.XID_SMOKE_PERSIST_PATH

if (smokePersistPath === undefined || smokePersistPath.length === 0) {
  throw new Error('XID_SMOKE_PERSIST_PATH missing')
}
const clientId = 'client_l3_protocol'
const resourceAudience = 'https://api.example/l3'
const scimToken = 'scim_l3_protocol_token'
const scimDirectoryId = 'dir_l3_protocol'
const outboundSamlAppId = 'saml_sp_l3_protocol'
const outboundScimTargetId = 'scim_target_l3_protocol'
const outboundScimTokenSecretName = 'SCIM_TARGET_TOKEN_scim_target_l3_protocol'
const outboundDeactivatedUserId = 'user_l3_scim_deactivated'

const ARGON2_MEMORY_KB = 65536
const ARGON2_ITERATIONS = 3
const ARGON2_HASH_LEN = 32
const ARGON2_PARALLELISM = 1
const SAML_IDP_CERT_B64 = process.env.XID_L3_SAML_IDP_CERT_B64

if (!SAML_IDP_CERT_B64) throw new Error('XID_L3_SAML_IDP_CERT_B64 missing')

Application.setEngine('webcrypto', crypto)
setNodeDependencies({ DOMParser, XMLSerializer, xpath })

function printResult(status, name, detail) {
  process.stdout.write(`${status} ${name}${detail ? ` ${detail}` : ''}\n`)
}

function base64UrlEncode(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function base64UrlEncodeString(value) {
  return base64UrlEncode(new TextEncoder().encode(value))
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function b64ToBytes(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}

function readSamlIdpKeyPkcs8() {
  const key = process.env.XID_L3_SAML_IDP_KEY_PKCS8_B64
  if (!key) throw new Error('XID_L3_SAML_IDP_KEY_PKCS8_B64 missing')
  return b64ToBytes(key)
}

async function envelopeEncrypt(plaintext, kekRaw) {
  const key = await crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const combined = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  )
  return {
    iv,
    ciphertext: combined.slice(0, combined.byteLength - 16),
    tag: combined.slice(combined.byteLength - 16),
  }
}

function decodePepper(raw) {
  const match = raw.match(/^v\d+:(.+)$/)
  const value = match ? match[1] : raw
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

function currentPepperVersion(raw) {
  const match = raw.match(/^v(\d+):/)
  return match ? Number.parseInt(match[1], 10) : 1
}

function applyPepper(password, pepper) {
  const encoded = new TextEncoder().encode(password)
  const out = new Uint8Array(pepper.length + encoded.length)
  out.set(pepper, 0)
  out.set(encoded, pepper.length)
  return out
}

function encodeArgon2Hash(digest, salt) {
  return `$argon2id$v=19$m=${ARGON2_MEMORY_KB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}$${base64UrlEncode(salt)}$${base64UrlEncode(digest)}`
}

async function hashPassword(password, pepperRaw) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const digest = argon2id(applyPepper(password, decodePepper(pepperRaw)), salt, {
    m: ARGON2_MEMORY_KB,
    t: ARGON2_ITERATIONS,
    p: ARGON2_PARALLELISM,
    dkLen: ARGON2_HASH_LEN,
    version: 0x13,
  })
  return {
    hash: encodeArgon2Hash(digest, salt),
    algo: 'argon2id',
    pepperVersion: currentPepperVersion(pepperRaw),
  }
}

async function passwordReuseTag(password, pepperRaw) {
  const key = await crypto.subtle.importKey(
    'raw',
    decodePepper(pepperRaw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const normalized = password.length > 128 ? password.slice(0, 128) : password
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalized))
  return `pwd-reuse:v1:${Buffer.from(new Uint8Array(sig)).toString('base64')}`
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Bytes(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

function parseDevVars() {
  const {
    XID_SMOKE_KEK: KEK,
    XID_SMOKE_PEPPER: PEPPER,
    XID_SMOKE_SCIM_TARGET_TOKEN: SCIM_TARGET_TOKEN,
  } = process.env
  if (!KEK || !PEPPER || !SCIM_TARGET_TOKEN) {
    throw new Error(
      'XID smoke KEK, PEPPER, and SCIM target token must be provided through the process environment',
    )
  }
  return { KEK, PEPPER, SCIM_TARGET_TOKEN }
}

async function run(command, args, name) {
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  if (result.code !== 0) throw new Error(`${name} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

async function applyLocalMigrations() {
  await run(
    PACKAGE_MANAGER,
    [
      ...PACKAGE_MANAGER_ARGS,
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--persist-to',
      smokePersistPath,
    ],
    'apply local D1 migrations',
  )
  printResult('PASS', 'local D1 migrations')
}

async function d1(command, name) {
  const stdout = await run(
    PACKAGE_MANAGER,
    [
      ...PACKAGE_MANAGER_ARGS,
      'exec',
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--local',
      '--persist-to',
      smokePersistPath,
      '--command',
      command,
      '--json',
    ],
    name,
  )
  const parsed = parseD1Json(stdout, name)
  const first = parsed[0]
  if (!first?.success) throw new Error(`${name} failed: ${stdout}`)
  return first.results ?? []
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function sqlJson(value) {
  return sqlString(JSON.stringify(value))
}

async function fetchText(path, options = {}) {
  const headers = new Headers(options.headers)
  if (options.cookie) headers.set('cookie', options.cookie)
  const res = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' })
  const text = await res.text()
  return { res, text }
}

async function readRequestBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function xmlChildren(parent, localName) {
  const out = []
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1 && node.localName === localName) out.push(node)
  }
  return out
}

function firstXmlChild(parent, localName) {
  return xmlChildren(parent, localName)[0] ?? null
}

async function importSamlCertVerifyKey() {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    readSamlIdpKeyPkcs8(),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', key)
  delete jwk.d
  delete jwk.dp
  delete jwk.dq
  delete jwk.p
  delete jwk.q
  delete jwk.qi
  jwk.key_ops = ['verify']
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, [
    'verify',
  ])
}

async function verifySignedElement(doc, element, verifyKey) {
  const sig = firstXmlChild(element, 'Signature')
  if (!sig) throw new Error(`SAML ${element.localName} missing Signature`)
  const signedXml = new SignedXml(doc)
  signedXml.LoadXml(sig)
  if (!(await signedXml.Verify(verifyKey)))
    throw new Error(`SAML ${element.localName} signature invalid`)
}

async function verifyOutboundSamlResponse(samlResponse, expected) {
  const xml = Buffer.from(samlResponse, 'base64').toString('utf8')
  const doc = Parse(xml)
  const response = doc.documentElement
  const assertion = firstXmlChild(response, 'Assertion')
  if (!assertion) throw new Error('SAML Assertion missing')
  const verifyKey = await importSamlCertVerifyKey()
  await verifySignedElement(doc, assertion, verifyKey)
  await verifySignedElement(doc, response, verifyKey)
  const issuer = firstXmlChild(response, 'Issuer')?.textContent ?? ''
  const subjectElement = firstXmlChild(assertion, 'Subject')
  const subject = firstXmlChild(subjectElement, 'NameID')?.textContent ?? ''
  const confirmation = firstXmlChild(subjectElement, 'SubjectConfirmation')
  const confirmationData = firstXmlChild(confirmation, 'SubjectConfirmationData')
  const audience =
    firstXmlChild(
      firstXmlChild(firstXmlChild(assertion, 'Conditions'), 'AudienceRestriction'),
      'Audience',
    )?.textContent ?? ''
  if (issuer !== expected.issuer) throw new Error(`SAML issuer mismatch: ${issuer}`)
  if (subject !== adminEmail) throw new Error(`SAML subject mismatch: ${subject}`)
  if (audience !== expected.audience) throw new Error(`SAML audience mismatch: ${audience}`)
  if (
    expected.inResponseTo &&
    (response.getAttribute('InResponseTo') !== expected.inResponseTo ||
      confirmationData?.getAttribute('InResponseTo') !== expected.inResponseTo)
  ) {
    throw new Error(`SAML InResponseTo mismatch: ${expected.inResponseTo}`)
  }
  if (!xml.includes('User.Email')) throw new Error('SAML User.Email attribute missing')
}

async function startFakeSaasServer(expectedScimToken) {
  const calls = []
  const scimResources = {
    Users: new Map(),
    Groups: new Map(),
  }
  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/saml/acs' && req.method === 'POST') {
        const params = new URLSearchParams(await readRequestBody(req))
        const samlResponse = params.get('SAMLResponse')
        if (!samlResponse) throw new Error('SAMLResponse missing')
        calls.push({ kind: 'saml', samlResponse, relayState: params.get('RelayState') })
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('saml-ok')
        return
      }
      if (url.pathname === '/oidc/callback' && req.method === 'GET') {
        calls.push({
          kind: 'oidc',
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
          iss: url.searchParams.get('iss'),
        })
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('oidc-ok')
        return
      }
      if (url.pathname.startsWith('/scim/v2/')) {
        const auth = req.headers.authorization ?? ''
        if (auth !== `Bearer ${expectedScimToken}`) {
          res.writeHead(401, { 'content-type': 'application/scim+json' })
          res.end(JSON.stringify({ status: '401', detail: 'Unauthorized' }))
          return
        }
        const bodyText = await readRequestBody(req)
        const body = bodyText ? JSON.parse(bodyText) : {}
        calls.push({ kind: 'scim', method: req.method, path: url.pathname, body })
        const collectionMatch = /^\/scim\/v2\/(Users|Groups)$/u.exec(url.pathname)
        const resourceMatch = /^\/scim\/v2\/(Users|Groups)\/([^/]+)$/u.exec(url.pathname)
        if (collectionMatch && req.method === 'GET') {
          const collection = scimResources[collectionMatch[1]]
          const filter = url.searchParams.get('filter') ?? ''
          const externalId = /^externalId eq "([^"]+)"$/u.exec(filter)?.[1]
          const resources =
            externalId === undefined
              ? [...collection.values()]
              : [...collection.values()].filter((resource) => resource.externalId === externalId)
          res.writeHead(200, { 'content-type': 'application/scim+json' })
          res.end(
            JSON.stringify({
              schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
              totalResults: resources.length,
              startIndex: 1,
              itemsPerPage: resources.length,
              Resources: resources,
            }),
          )
          return
        }
        if (collectionMatch && req.method === 'POST') {
          const collection = scimResources[collectionMatch[1]]
          const existing = [...collection.values()].find(
            (resource) => resource.externalId === body.externalId,
          )
          if (existing) {
            res.writeHead(409, { 'content-type': 'application/scim+json' })
            res.end(JSON.stringify({ status: '409', detail: 'Resource already exists' }))
            return
          }
          const id = body.externalId ?? crypto.randomUUID()
          const resource = { ...body, id }
          collection.set(id, resource)
          res.writeHead(201, { 'content-type': 'application/scim+json' })
          res.end(JSON.stringify(resource))
          return
        }
        if (resourceMatch && req.method === 'PUT') {
          const collection = scimResources[resourceMatch[1]]
          const id = decodeURIComponent(resourceMatch[2])
          if (!collection.has(id)) {
            res.writeHead(404, { 'content-type': 'application/scim+json' })
            res.end(JSON.stringify({ status: '404', detail: 'Resource not found' }))
            return
          }
          const resource = { ...body, id }
          collection.set(id, resource)
          res.writeHead(200, { 'content-type': 'application/scim+json' })
          res.end(JSON.stringify(resource))
          return
        }
        if (resourceMatch?.[1] === 'Users' && req.method === 'PATCH') {
          const id = decodeURIComponent(resourceMatch[2])
          const existing = scimResources.Users.get(id) ?? { id }
          const resource = { ...existing, active: false }
          scimResources.Users.set(id, resource)
          res.writeHead(200, { 'content-type': 'application/scim+json' })
          res.end(JSON.stringify(resource))
          return
        }
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    } catch (error) {
      console.error('fake SaaS server request failed', error)
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('internal provider error')
    }
  })
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake SaaS server address missing')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function collectSetCookie(res) {
  const cookies = []
  if (typeof res.headers.getSetCookie === 'function') cookies.push(...res.headers.getSetCookie())
  const single = res.headers.get('set-cookie')
  if (single) cookies.push(single)
  return cookies.map((value) => value.split(';')[0]).join('; ')
}

function parseJson(text, name) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} returned non-json body: ${text.slice(0, 200)}`)
  }
}

async function ensureSeeded() {
  const res = await fetch(`${baseUrl}/admin/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instanceName: 'XID Dev',
      primaryDomain: 'localhost',
      mode: 'single_tenant',
      adminEmail,
    }),
  })
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(`bootstrap failed http=${res.status} body=${await res.text()}`)
  }
  printResult('PASS', 'bootstrap', `http=${res.status}`)
}

async function prepareFixture() {
  const vars = parseDevVars()
  if (!vars.PEPPER) throw new Error('XID smoke PEPPER missing from the process environment')
  if (!vars.KEK) throw new Error('XID smoke KEK missing from the process environment')
  const rows = await d1(
    `SELECT users.id AS user_id, users.tenant_id AS tenant_id, organizations.private_metadata AS private_metadata FROM users JOIN user_emails ON user_emails.user_id = users.id JOIN organizations ON organizations.id = users.tenant_id WHERE user_emails.email = ${sqlString(adminEmail)} LIMIT 1;`,
    'load admin user',
  )
  const row = rows[0]
  if (!row) throw new Error(`admin user not found: ${adminEmail}`)

  const metadata = JSON.parse(row.private_metadata || '{}')
  const originalMetadata = JSON.stringify(metadata)
  metadata.hostedAuth = {
    ...(metadata.hostedAuth ?? {}),
    identifierMode: 'email',
    requireVerifiedEmail: true,
    password: {
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
  }
  const now = Date.now()
  const passwordHash = await hashPassword(adminPassword, vars.PEPPER)
  const reuseTag = await passwordReuseTag(adminPassword, vars.PEPPER)
  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const codeChallenge = base64UrlEncode(await sha256Bytes(codeVerifier))
  const scimTokenHash = await sha256Hex(scimToken)
  const certBlob = await envelopeEncrypt(readSamlIdpKeyPkcs8(), b64ToBytes(vars.KEK))

  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${now} WHERE id = ${sqlString(row.tenant_id)};`,
    'enable local password policy',
  )
  await d1(
    `INSERT INTO passwords (id, tenant_id, user_id, hash, algo, pepper_version, reuse_tag, breached, created_at, updated_at) VALUES (${sqlString(`pw_l3_protocol_${row.user_id}`)}, ${sqlString(row.tenant_id)}, ${sqlString(row.user_id)}, ${sqlString(passwordHash.hash)}, ${sqlString(passwordHash.algo)}, ${passwordHash.pepperVersion}, ${sqlString(reuseTag)}, 0, ${now}, ${now}) ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, algo = excluded.algo, pepper_version = excluded.pepper_version, reuse_tag = excluded.reuse_tag, updated_at = excluded.updated_at;`,
    'upsert local password',
  )
  await d1(
    `INSERT INTO applications (id, tenant_id, project_id, client_id, client_secret_hash, client_type, token_endpoint_auth_method, redirect_uris, post_logout_redirect_uris, allowed_grant_types, allowed_response_types, allowed_scopes, require_pkce, dpop_bound_access_tokens, access_token_format, access_token_ttl_sec, id_token_signed_alg, first_party, require_org_context, custom_claims_config, status, created_at, updated_at) VALUES ('app_l3_protocol', ${sqlString(row.tenant_id)}, NULL, ${sqlString(clientId)}, NULL, 'public', 'none', ${sqlJson([])}, ${sqlJson([])}, ${sqlJson(['authorization_code', 'refresh_token'])}, ${sqlJson(['code'])}, ${sqlJson(['openid', 'profile', 'email', 'offline_access'])}, 1, 1, 'jwt', 3600, 'ES256', 1, 0, '{}', 'active', ${now}, ${now}) ON CONFLICT(client_id) DO UPDATE SET tenant_id = excluded.tenant_id, project_id = excluded.project_id, client_secret_hash = excluded.client_secret_hash, client_type = excluded.client_type, token_endpoint_auth_method = excluded.token_endpoint_auth_method, allowed_grant_types = excluded.allowed_grant_types, allowed_response_types = excluded.allowed_response_types, allowed_scopes = excluded.allowed_scopes, require_pkce = excluded.require_pkce, dpop_bound_access_tokens = excluded.dpop_bound_access_tokens, first_party = excluded.first_party, status = 'active', updated_at = excluded.updated_at;`,
    'upsert local OAuth client',
  )
  await d1(
    `DELETE FROM oauth_consents WHERE tenant_id = ${sqlString(row.tenant_id)} AND user_id = ${sqlString(row.user_id)} AND client_id = ${sqlString(clientId)};`,
    'clear local OAuth consent for consent-flow smoke',
  )
  await d1(
    `INSERT INTO resource_servers (id, tenant_id, name, audience, scopes, access_token_format, signing_alg, created_at, updated_at) VALUES ('rs_l3_protocol', ${sqlString(row.tenant_id)}, 'L3 Protocol API', ${sqlString(resourceAudience)}, ${sqlJson(['openid', 'profile', 'email'])}, 'jwt', 'ES256', ${now}, ${now}) ON CONFLICT(tenant_id, audience) DO UPDATE SET name = excluded.name, scopes = excluded.scopes, updated_at = excluded.updated_at;`,
    'upsert local resource server',
  )
  await d1(
    `INSERT INTO directories (id, tenant_id, org_id, provider, scim_token_hash, scim_token_hash_prev, scim_token_prev_expires, sync_status, status, created_at, updated_at) VALUES (${sqlString(scimDirectoryId)}, ${sqlString(row.tenant_id)}, ${sqlString(row.tenant_id)}, 'l3-protocol', ${sqlString(scimTokenHash)}, NULL, NULL, 'idle', 'active', ${now}, ${now}) ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, org_id = excluded.org_id, provider = excluded.provider, scim_token_hash = excluded.scim_token_hash, scim_token_hash_prev = NULL, scim_token_prev_expires = NULL, sync_status = 'idle', status = 'active', deleted_at = NULL, updated_at = excluded.updated_at;`,
    'upsert local SCIM directory',
  )
  await d1(
    `INSERT INTO cert_store (id, tenant_id, usage, certificate, private_key_iv, private_key_ciphertext, private_key_tag, kek_version, status, not_before, not_after, fingerprint, created_at, updated_at) VALUES ('cert_l3_outbound_saml', ${sqlString(row.tenant_id)}, 'saml_idp_signing', ${sqlString(SAML_IDP_CERT_B64)}, X'${Buffer.from(certBlob.iv).toString('hex')}', X'${Buffer.from(certBlob.ciphertext).toString('hex')}', X'${Buffer.from(certBlob.tag).toString('hex')}', 1, 'active', NULL, NULL, 'l3-outbound-saml', ${now}, ${now}) ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, usage = excluded.usage, certificate = excluded.certificate, private_key_iv = excluded.private_key_iv, private_key_ciphertext = excluded.private_key_ciphertext, private_key_tag = excluded.private_key_tag, kek_version = excluded.kek_version, status = 'active', updated_at = excluded.updated_at;`,
    'upsert outbound SAML signing cert',
  )
  await d1(
    `INSERT INTO saml_service_providers (id, tenant_id, org_id, sp_entity_id, acs_url, attribute_mapping, name_id_format, idp_signing_cert_id, created_at, updated_at) VALUES (${sqlString(outboundSamlAppId)}, ${sqlString(row.tenant_id)}, ${sqlString(row.tenant_id)}, ${sqlString('https://fake-saas.example/saml/metadata')}, '__PENDING_ACS__', ${sqlJson({ email: 'email', userEmail: 'User.Email', firstName: 'firstName', lastName: 'lastName', displayName: 'displayName' })}, 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress', 'cert_l3_outbound_saml', ${now}, ${now}) ON CONFLICT(tenant_id, org_id, sp_entity_id) DO UPDATE SET acs_url = excluded.acs_url, attribute_mapping = excluded.attribute_mapping, name_id_format = excluded.name_id_format, idp_signing_cert_id = excluded.idp_signing_cert_id, updated_at = excluded.updated_at;`,
    'upsert outbound SAML SP placeholder',
  )
  await d1(
    `INSERT INTO users (id, tenant_id, username, external_id, primary_email_id, first_name, last_name, display_name, public_metadata, private_metadata, unsafe_metadata, custom_attributes, status, password_change_required, is_new_user, profile_completion_status, failed_login_count, provisioned_by, deleted_at, created_at, updated_at) VALUES (${sqlString(outboundDeactivatedUserId)}, ${sqlString(row.tenant_id)}, 'l3.deactivated@example.com', ${sqlString(outboundDeactivatedUserId)}, 'email_l3_deactivated', 'L3', 'Deactivated', 'L3 Deactivated', '{}', '{}', '{}', '{}', 'deactivated', 0, 0, 'complete', 0, 'l3-protocol', NULL, ${now}, ${now}) ON CONFLICT(id) DO UPDATE SET status = 'deactivated', updated_at = excluded.updated_at;`,
    'upsert deactivated outbound SCIM user',
  )
  await d1(
    `INSERT INTO user_emails (id, tenant_id, user_id, email, verified, verification_status, is_primary, verified_at, created_at, updated_at) VALUES ('email_l3_deactivated', ${sqlString(row.tenant_id)}, ${sqlString(outboundDeactivatedUserId)}, 'l3.deactivated@example.com', 1, 'verified', 1, ${now}, ${now}, ${now}) ON CONFLICT(tenant_id, email) DO UPDATE SET user_id = excluded.user_id, verified = 1, is_primary = 1, updated_at = excluded.updated_at;`,
    'upsert deactivated outbound SCIM email',
  )
  printResult('PASS', 'local protocol client fixture', `org=${row.tenant_id}`)
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    originalMetadata,
    codeVerifier,
    codeChallenge,
  }
}

async function configureFakeSaasTargets(fixture, fakeSaas) {
  const now = Date.now()
  const oidcRedirectUri = `${fakeSaas.baseUrl}/oidc/callback`
  fixture.redirectUri = oidcRedirectUri
  await d1(
    `UPDATE applications SET redirect_uris = ${sqlJson([oidcRedirectUri])}, updated_at = ${now} WHERE tenant_id = ${sqlString(fixture.tenantId)} AND client_id = ${sqlString(clientId)};`,
    'configure fake OIDC RP redirect URI',
  )
  await d1(
    `UPDATE saml_service_providers SET acs_url = ${sqlString(`${fakeSaas.baseUrl}/saml/acs`)}, updated_at = ${now} WHERE tenant_id = ${sqlString(fixture.tenantId)} AND id = ${sqlString(outboundSamlAppId)};`,
    'configure fake SAML ACS',
  )
  await d1(
    `INSERT INTO scim_targets (id, tenant_id, org_id, provider, base_url, token_secret_ref, user_filter, status, last_sync_at, created_at, updated_at) VALUES (${sqlString(outboundScimTargetId)}, ${sqlString(fixture.tenantId)}, ${sqlString(fixture.tenantId)}, 'fake-saas', ${sqlString(`${fakeSaas.baseUrl}/scim/v2`)}, ${sqlString(outboundScimTokenSecretName)}, '{}', 'active', NULL, ${now}, ${now}) ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, org_id = excluded.org_id, provider = excluded.provider, base_url = excluded.base_url, token_secret_ref = excluded.token_secret_ref, user_filter = '{}', status = 'active', updated_at = excluded.updated_at;`,
    'configure fake SCIM target',
  )
  await d1(
    `INSERT INTO scim_target_resources (id, tenant_id, org_id, target_id, resource_type, local_resource_id, external_id, downstream_id, status, last_synced_at, created_at, updated_at) VALUES ('str_l3_deactivated', ${sqlString(fixture.tenantId)}, ${sqlString(fixture.tenantId)}, ${sqlString(outboundScimTargetId)}, 'User', ${sqlString(outboundDeactivatedUserId)}, ${sqlString(outboundDeactivatedUserId)}, ${sqlString(outboundDeactivatedUserId)}, 'active', ${now}, ${now}, ${now}) ON CONFLICT(tenant_id, target_id, resource_type, local_resource_id) DO UPDATE SET downstream_id = excluded.downstream_id, status = 'active', last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at;`,
    'configure stale outbound SCIM mapping',
  )
  printResult('PASS', 'fake SaaS target fixture', fakeSaas.baseUrl)
}

async function restoreFixture(fixture) {
  if (!fixture) return
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(fixture.originalMetadata)}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'restore local hosted auth policy',
  )
  await d1(
    `DELETE FROM directory_group_members WHERE tenant_id = ${sqlString(fixture.tenantId)} AND id LIKE 'dgm_l3_protocol_%';`,
    'cleanup local SCIM group members',
  )
  await d1(
    `DELETE FROM directory_groups WHERE tenant_id = ${sqlString(fixture.tenantId)} AND directory_id = ${sqlString(scimDirectoryId)};`,
    'cleanup local SCIM groups',
  )
  await d1(
    `DELETE FROM directory_users WHERE tenant_id = ${sqlString(fixture.tenantId)} AND directory_id = ${sqlString(scimDirectoryId)};`,
    'cleanup local SCIM users',
  )
  await d1(
    `DELETE FROM authorization_codes WHERE tenant_id = ${sqlString(fixture.tenantId)} AND client_id = ${sqlString(clientId)};`,
    'cleanup local OAuth codes',
  )
  await d1(
    `DELETE FROM scim_target_resources WHERE tenant_id = ${sqlString(fixture.tenantId)} AND target_id = ${sqlString(outboundScimTargetId)};`,
    'cleanup outbound SCIM resource mappings',
  )
  await d1(
    `DELETE FROM scim_targets WHERE tenant_id = ${sqlString(fixture.tenantId)} AND id = ${sqlString(outboundScimTargetId)};`,
    'cleanup outbound SCIM target',
  )
  await d1(
    `DELETE FROM saml_service_providers WHERE tenant_id = ${sqlString(fixture.tenantId)} AND id = ${sqlString(outboundSamlAppId)};`,
    'cleanup outbound SAML SP',
  )
  await d1(
    `DELETE FROM cert_store WHERE tenant_id = ${sqlString(fixture.tenantId)} AND id = 'cert_l3_outbound_saml';`,
    'cleanup outbound SAML cert',
  )
  await d1(
    `DELETE FROM user_emails WHERE tenant_id = ${sqlString(fixture.tenantId)} AND user_id = ${sqlString(outboundDeactivatedUserId)};`,
    'cleanup outbound SCIM deactivated email',
  )
  await d1(
    `DELETE FROM users WHERE tenant_id = ${sqlString(fixture.tenantId)} AND id = ${sqlString(outboundDeactivatedUserId)};`,
    'cleanup outbound SCIM deactivated user',
  )
  printResult('PASS', 'restore local protocol fixture')
}

async function login() {
  const res = await fetchText('/auth/password/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: adminEmail, password: adminPassword }),
  })
  if (res.res.status !== 200) {
    throw new Error(`password sign-in failed http=${res.res.status} body=${res.text}`)
  }
  const cookie = collectSetCookie(res.res)
  if (!cookie.includes('__Host-xid.rt.')) throw new Error('password sign-in did not set cookie')
  printResult('PASS', 'protocol client password sign-in', `http=${res.res.status}`)
  return cookie
}

async function signDpop(input) {
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: input.publicJwk,
  }
  const payload = {
    htm: input.htm,
    htu: input.htu,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    ...(input.accessToken ? { ath: base64UrlEncode(await sha256Bytes(input.accessToken)) } : {}),
  }
  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
    JSON.stringify(payload),
  )}`
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      input.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  )
  return `${signingInput}.${base64UrlEncode(sig)}`
}

async function makeDpopKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const publicJwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y }
  return { privateKey: pair.privateKey, publicJwk }
}

async function completeConsentFlow(cookie, authzLocation) {
  const url = new URL(authzLocation, baseUrl)
  const promptId = url.searchParams.get('authz_request_id') ?? url.searchParams.get('prompt_id')
  if (!promptId) throw new Error(`consent redirect missing prompt id: ${authzLocation}`)

  const consentPage = await fetchText(url.pathname + url.search, { cookie })
  if (consentPage.res.status !== 200) {
    throw new Error(`consent page failed http=${consentPage.res.status}`)
  }
  if (!consentPage.text.includes('id="root"')) {
    throw new Error('consent page missing SPA root mount')
  }
  printResult('PASS', 'consent page', `http=${consentPage.res.status}`)

  const params = await fetchText(`/auth/consent-params?prompt_id=${encodeURIComponent(promptId)}`, {
    cookie,
  })
  if (params.res.status !== 200) {
    throw new Error(`consent params failed http=${params.res.status} body=${params.text}`)
  }
  const paramsJson = parseJson(params.text, '/auth/consent-params')
  if (!paramsJson.clientId) throw new Error(`consent params missing clientId: ${params.text}`)
  printResult('PASS', 'consent params', `client=${paramsJson.clientId}`)

  const consent = await fetchText('/auth/consent', {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ promptId, approved: true }),
  })
  if (consent.res.status !== 200) {
    throw new Error(`consent approve failed http=${consent.res.status} body=${consent.text}`)
  }
  const consentJson = parseJson(consent.text, '/auth/consent')
  if (typeof consentJson.redirectUrl !== 'string') {
    throw new Error(`consent missing redirectUrl: ${consent.text}`)
  }
  printResult('PASS', 'consent approve', `redirect=${consentJson.redirectUrl.slice(0, 48)}`)
  return consentJson.redirectUrl
}

async function runDcrClientCredentials() {
  const register = await fetchText('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'L3 DCR M2M',
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['client_credentials'],
      response_types: [],
      scope: 'openid profile',
    }),
  })
  if (register.res.status !== 201) {
    throw new Error(`/register failed http=${register.res.status} body=${register.text}`)
  }
  const reg = parseJson(register.text, '/register')
  if (!reg.client_id || !reg.client_secret) {
    throw new Error(`/register missing client credentials: ${register.text}`)
  }
  printResult('PASS', 'DCR client_credentials client', `client_id=${reg.client_id}`)

  const creds = btoa(`${reg.client_id}:${reg.client_secret}`)
  const token = await fetchText('/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${creds}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'openid profile',
    }),
  })
  if (token.res.status !== 200) {
    throw new Error(`/token client_credentials failed http=${token.res.status} body=${token.text}`)
  }
  const tokenJson = parseJson(token.text, '/token client_credentials')
  if (!tokenJson.access_token)
    throw new Error(`client_credentials missing access_token: ${token.text}`)
  printResult('PASS', 'DCR client_credentials token', `token_type=${tokenJson.token_type}`)
}

async function runOAuthClient(cookie, fixture, fakeSaas) {
  if (!fixture.redirectUri) throw new Error('fake OIDC RP redirect URI missing')
  const parBody = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: fixture.redirectUri,
    scope: 'openid profile email offline_access',
    state: 'st_l3_protocol',
    nonce: 'nonce_l3_protocol',
    code_challenge: fixture.codeChallenge,
    code_challenge_method: 'S256',
    resource: resourceAudience,
  })
  const par = await fetchText('/par', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: parBody,
  })
  if (par.res.status !== 201) throw new Error(`/par failed http=${par.res.status} body=${par.text}`)
  const parJson = parseJson(par.text, '/par')
  if (typeof parJson.request_uri !== 'string')
    throw new Error(`/par missing request_uri: ${par.text}`)
  printResult('PASS', 'protocol client PAR', `expires=${parJson.expires_in}`)

  const authz = await fetchText(
    `/authorize?${new URLSearchParams({ client_id: clientId, request_uri: parJson.request_uri })}`,
    { cookie },
  )
  if (authz.res.status !== 302) {
    throw new Error(`/authorize failed http=${authz.res.status} body=${authz.text}`)
  }
  let location = authz.res.headers.get('location') ?? ''
  if (location.includes('/consent')) {
    location = await completeConsentFlow(cookie, location)
  }
  const rpRes = await fetch(location, { redirect: 'manual' })
  if (rpRes.status !== 200) throw new Error(`fake OIDC RP callback failed http=${rpRes.status}`)
  const oidcCall = fakeSaas.calls.find((entry) => entry.kind === 'oidc')
  if (!oidcCall) throw new Error('fake OIDC RP did not receive callback')
  const code = oidcCall.code
  if (!code) throw new Error(`/authorize did not return code location=${location}`)
  if (oidcCall.state !== 'st_l3_protocol') {
    throw new Error(`/authorize state mismatch location=${location}`)
  }
  if (oidcCall.iss !== baseUrl) {
    throw new Error(`/authorize iss mismatch location=${location}`)
  }
  printResult('PASS', 'fake SaaS OIDC RP callback', `code=${code.slice(0, 6)}`)

  const dpopKey = await makeDpopKey()
  const tokenDpop = await signDpop({
    ...dpopKey,
    htm: 'POST',
    htu: `${baseUrl}/token`,
  })
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: fixture.redirectUri,
    code_verifier: fixture.codeVerifier,
    resource: resourceAudience,
  })
  const token = await fetchText('/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      dpop: tokenDpop,
    },
    body: tokenBody,
  })
  if (token.res.status !== 200) {
    throw new Error(`/token failed http=${token.res.status} body=${token.text}`)
  }
  const tokenJson = parseJson(token.text, '/token')
  if (tokenJson.token_type !== 'DPoP' || typeof tokenJson.access_token !== 'string') {
    throw new Error(`/token DPoP body mismatch: ${token.text}`)
  }
  printResult('PASS', 'protocol client DPoP token', `type=${tokenJson.token_type}`)

  const userinfoDpop = await signDpop({
    ...dpopKey,
    htm: 'GET',
    htu: `${baseUrl}/userinfo`,
    accessToken: tokenJson.access_token,
  })
  const userinfo = await fetchText('/userinfo', {
    headers: {
      authorization: `DPoP ${tokenJson.access_token}`,
      dpop: userinfoDpop,
    },
  })
  if (userinfo.res.status !== 200) {
    throw new Error(`/userinfo failed http=${userinfo.res.status} body=${userinfo.text}`)
  }
  const userinfoJson = parseJson(userinfo.text, '/userinfo')
  if (userinfoJson.sub !== fixture.userId || userinfoJson.email !== adminEmail) {
    throw new Error(`/userinfo claims mismatch: ${userinfo.text}`)
  }
  printResult('PASS', 'protocol client DPoP userinfo', `sub=${userinfoJson.sub}`)
}

async function runScimClient(fixture) {
  const auth = { authorization: `Bearer ${scimToken}` }
  const service = await fetchText('/scim/v2/ServiceProviderConfig', { headers: auth })
  if (service.res.status !== 200) {
    throw new Error(`/ServiceProviderConfig failed http=${service.res.status} body=${service.text}`)
  }
  const serviceJson = parseJson(service.text, 'SCIM ServiceProviderConfig')
  if (serviceJson.sort?.supported !== true) {
    throw new Error(`SCIM sort unsupported: ${service.text}`)
  }
  if (serviceJson.bulk?.supported !== true) {
    throw new Error(`SCIM bulk unsupported: ${service.text}`)
  }
  if (serviceJson.etag?.supported !== true) {
    throw new Error(`SCIM etag unsupported: ${service.text}`)
  }
  printResult('PASS', 'protocol client SCIM ServiceProviderConfig', `http=${service.res.status}`)

  const userPath = `/scim/v2/organizations/${encodeURIComponent(fixture.tenantId)}/Users`
  const created = await fetchText(userPath, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/scim+json' },
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'l3.user@example.com',
      externalId: 'l3-user',
      active: true,
      emails: [{ value: 'l3.user@example.com', primary: true }],
    }),
  })
  if (created.res.status !== 201) {
    throw new Error(`SCIM user create failed http=${created.res.status} body=${created.text}`)
  }
  const createdUser = parseJson(created.text, 'SCIM user create')
  if (typeof createdUser.id !== 'string') throw new Error(`SCIM user id missing: ${created.text}`)
  printResult('PASS', 'protocol client SCIM user create', `id=${createdUser.id}`)

  const listed = await fetchText(`${userPath}?filter=userName%20eq%20%22l3.user%40example.com%22`, {
    headers: auth,
  })
  if (listed.res.status !== 200) {
    throw new Error(`SCIM user list failed http=${listed.res.status} body=${listed.text}`)
  }
  const listedJson = parseJson(listed.text, 'SCIM user list')
  if (listedJson.totalResults !== 1) throw new Error(`SCIM list mismatch: ${listed.text}`)
  printResult('PASS', 'protocol client SCIM user list', `total=${listedJson.totalResults}`)

  const sorted = await fetchText(`${userPath}?sortBy=userName&sortOrder=ascending`, {
    headers: auth,
  })
  if (sorted.res.status !== 200) {
    throw new Error(`SCIM user sort failed http=${sorted.res.status} body=${sorted.text}`)
  }
  printResult('PASS', 'protocol client SCIM user sort', `http=${sorted.res.status}`)

  const getUser = await fetchText(`${userPath}/${encodeURIComponent(createdUser.id)}`, {
    headers: auth,
  })
  if (getUser.res.status !== 200) {
    throw new Error(`SCIM user get failed http=${getUser.res.status} body=${getUser.text}`)
  }
  const etag = getUser.res.headers.get('etag')
  if (!etag) throw new Error('SCIM user GET missing ETag header')

  const patch = await fetchText(`${userPath}/${encodeURIComponent(createdUser.id)}`, {
    method: 'PATCH',
    headers: {
      ...auth,
      'content-type': 'application/scim+json',
      'if-match': etag,
    },
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }),
  })
  if (patch.res.status !== 200) {
    throw new Error(`SCIM user patch failed http=${patch.res.status} body=${patch.text}`)
  }
  const patched = parseJson(patch.text, 'SCIM user patch')
  if (patched.active !== false) throw new Error(`SCIM patch active mismatch: ${patch.text}`)
  printResult('PASS', 'protocol client SCIM user patch', 'active=false')

  const groupPath = `/scim/v2/organizations/${encodeURIComponent(fixture.tenantId)}/Groups`
  const group = await fetchText(groupPath, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/scim+json' },
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'L3 Protocol Group',
      members: [{ value: createdUser.id }],
    }),
  })
  if (group.res.status !== 201) {
    throw new Error(`SCIM group create failed http=${group.res.status} body=${group.text}`)
  }
  const groupJson = parseJson(group.text, 'SCIM group create')
  if (typeof groupJson.id !== 'string') throw new Error(`SCIM group id missing: ${group.text}`)
  printResult('PASS', 'protocol client SCIM group create', `id=${groupJson.id}`)

  const deleted = await fetchText(`${groupPath}/${encodeURIComponent(groupJson.id)}`, {
    method: 'DELETE',
    headers: auth,
  })
  if (deleted.res.status !== 204) {
    throw new Error(`SCIM group delete failed http=${deleted.res.status} body=${deleted.text}`)
  }
  printResult('PASS', 'protocol client SCIM group delete', `http=${deleted.res.status}`)

  const bulkPath = `/scim/v2/organizations/${encodeURIComponent(fixture.tenantId)}/Bulk`
  const bulk = await fetchText(bulkPath, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/scim+json' },
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
      Operations: [
        {
          method: 'POST',
          path: '/Users',
          bulkId: 'bulk-user',
          data: {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            userName: 'l3.bulk@example.com',
            active: true,
          },
        },
      ],
    }),
  })
  if (bulk.res.status !== 200) {
    throw new Error(`SCIM bulk failed http=${bulk.res.status} body=${bulk.text}`)
  }
  const bulkJson = parseJson(bulk.text, 'SCIM bulk')
  const firstOp = bulkJson.Operations?.[0]
  if (firstOp?.status !== '201') {
    throw new Error(`SCIM bulk operation failed: ${bulk.text}`)
  }
  printResult('PASS', 'protocol client SCIM bulk', `status=${firstOp.status}`)
}

function hiddenInput(html, name) {
  const pattern = new RegExp(`name="${name}" value="([^"]*)"`)
  return pattern.exec(html)?.[1] ?? null
}

function formAction(html) {
  return /<form method="post" action="([^"]+)"/.exec(html)?.[1] ?? null
}

async function runOutboundSaml(cookie, fixture, fakeSaas) {
  const metadata = await fetchText(`/sso/outbound/saml/${outboundSamlAppId}/metadata`, { cookie })
  if (metadata.res.status !== 200) {
    throw new Error(
      `outbound SAML metadata failed http=${metadata.res.status} body=${metadata.text}`,
    )
  }
  if (
    !metadata.text.includes('IDPSSODescriptor') ||
    !metadata.text.includes(SAML_IDP_CERT_B64.replace(/\s+/g, ''))
  ) {
    throw new Error(`outbound SAML metadata mismatch: ${metadata.text.slice(0, 200)}`)
  }
  printResult('PASS', 'outbound SAML IdP metadata', `http=${metadata.res.status}`)

  const requestId = `_l3_${crypto.randomUUID().replaceAll('-', '')}`
  const destination = `${baseUrl}/sso/outbound/saml/${outboundSamlAppId}/sso`
  const requestXml = [
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"`,
    ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`,
    ` ID="${xmlEscape(requestId)}" Version="2.0" IssueInstant="${new Date().toISOString()}"`,
    ` Destination="${xmlEscape(destination)}"`,
    ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`,
    ` AssertionConsumerServiceURL="${xmlEscape(`${fakeSaas.baseUrl}/saml/acs`)}">`,
    `<saml:Issuer>https://fake-saas.example/saml/metadata</saml:Issuer>`,
    `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress" AllowCreate="true"/>`,
    `</samlp:AuthnRequest>`,
  ].join('')
  const mismatched = requestXml.replace(
    'https://fake-saas.example/saml/metadata',
    'https://attacker.example/saml/metadata',
  )
  const rejected = await fetchText(
    `/sso/outbound/saml/${outboundSamlAppId}/sso?${new URLSearchParams({
      SAMLRequest: deflateRawSync(Buffer.from(mismatched)).toString('base64'),
    })}`,
    { cookie },
  )
  if (rejected.res.status !== 400) {
    throw new Error(
      `outbound SAML mismatched AuthnRequest accepted http=${rejected.res.status} body=${rejected.text}`,
    )
  }
  printResult('PASS', 'outbound SAML rejects unregistered SP request', 'http=400')

  const sso = await fetchText(
    `/sso/outbound/saml/${outboundSamlAppId}/sso?${new URLSearchParams({
      SAMLRequest: deflateRawSync(Buffer.from(requestXml)).toString('base64'),
      RelayState: 'l3-relay',
    })}`,
    { cookie },
  )
  if (sso.res.status !== 200) {
    throw new Error(`outbound SAML SSO failed http=${sso.res.status} body=${sso.text}`)
  }
  const action = formAction(sso.text)
  const samlResponse = hiddenInput(sso.text, 'SAMLResponse')
  const relayState = hiddenInput(sso.text, 'RelayState')
  if (!action || !samlResponse) throw new Error(`outbound SAML form missing: ${sso.text}`)
  const acs = await fetch(action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState ?? '' }),
  })
  if (acs.status !== 200) throw new Error(`fake SAML ACS failed http=${acs.status}`)
  const call = fakeSaas.calls.find((entry) => entry.kind === 'saml')
  if (!call) throw new Error('fake SAML ACS did not receive Response')
  await verifyOutboundSamlResponse(call.samlResponse, {
    issuer: `${baseUrl}/sso/outbound/saml/${outboundSamlAppId}`,
    audience: 'https://fake-saas.example/saml/metadata',
    inResponseTo: requestId,
  })
  if (call.relayState !== 'l3-relay') throw new Error(`RelayState mismatch: ${call.relayState}`)
  printResult('PASS', 'outbound SAML SP-initiated signed response', `org=${fixture.tenantId}`)
}

async function runOutboundScim(cookie, fakeSaas, fixture) {
  const sync = await fetchText(`/scim/outbound/${outboundScimTargetId}/sync`, {
    method: 'POST',
    cookie,
  })
  if (sync.res.status !== 202) {
    throw new Error(`outbound SCIM sync failed http=${sync.res.status} body=${sync.text}`)
  }
  const body = parseJson(sync.text, 'outbound SCIM sync')
  if (
    body.status !== 'queued' ||
    body.targetId !== outboundScimTargetId ||
    typeof body.runId !== 'string' ||
    body.runId.length === 0
  ) {
    throw new Error(`outbound SCIM enqueue response mismatch: ${sync.text}`)
  }
  const scimCalls = await pollUntil(
    async () => fakeSaas.calls.filter((entry) => entry.kind === 'scim'),
    {
      isReady: (calls) => {
        const userPost = calls.some(
          (entry) => entry.method === 'POST' && entry.path === '/scim/v2/Users',
        )
        const groupPost = calls.some(
          (entry) => entry.method === 'POST' && entry.path === '/scim/v2/Groups',
        )
        const patch = calls.some(
          (entry) => entry.method === 'PATCH' && entry.path.includes(outboundDeactivatedUserId),
        )
        return userPost && groupPost && patch
      },
      label: 'outbound SCIM queue delivery',
    },
  )
  const userPost = scimCalls.find(
    (entry) => entry.method === 'POST' && entry.path === '/scim/v2/Users',
  )
  const groupPost = scimCalls.find(
    (entry) => entry.method === 'POST' && entry.path === '/scim/v2/Groups',
  )
  const patch = scimCalls.find(
    (entry) => entry.method === 'PATCH' && entry.path.includes(outboundDeactivatedUserId),
  )
  if (!userPost || !groupPost || !patch) {
    throw new Error(`outbound SCIM calls incomplete: ${JSON.stringify(scimCalls)}`)
  }
  const persisted = await pollUntil(
    async () =>
      d1(
        `SELECT scim_targets.last_sync_at AS last_sync_at, scim_target_resources.status AS mapping_status FROM scim_targets JOIN scim_target_resources ON scim_target_resources.target_id = scim_targets.id AND scim_target_resources.tenant_id = scim_targets.tenant_id WHERE scim_targets.tenant_id = ${sqlString(fixture.tenantId)} AND scim_targets.id = ${sqlString(outboundScimTargetId)} AND scim_target_resources.local_resource_id = ${sqlString(outboundDeactivatedUserId)} LIMIT 1;`,
        'load outbound SCIM completion evidence',
      ),
    {
      isReady: (rows) =>
        rows[0]?.last_sync_at != null && rows[0]?.mapping_status === 'deprovisioned',
      label: 'outbound SCIM persistence',
    },
  )
  printResult(
    'PASS',
    'outbound SCIM target sync',
    `run=${body.runId} mapping=${persisted[0].mapping_status}`,
  )
}

export async function runL3ProtocolClientSmoke() {
  let fixture
  let fakeSaas
  try {
    await applyLocalMigrations()
    const health = await fetchText('/v1/health')
    if (health.res.status !== 200) {
      throw new Error(`dev server not healthy http=${health.res.status} body=${health.text}`)
    }
    printResult('PASS', 'dev server health', `http=${health.res.status}`)
    await ensureSeeded()
    fixture = await prepareFixture()
    const vars = parseDevVars()
    fakeSaas = await startFakeSaasServer(vars.SCIM_TARGET_TOKEN)
    await configureFakeSaasTargets(fixture, fakeSaas)
    await runDcrClientCredentials()
    const cookie = await login()
    await runOAuthClient(cookie, fixture, fakeSaas)
    await runScimClient(fixture)
    await runOutboundSaml(cookie, fixture, fakeSaas)
    await runOutboundScim(cookie, fakeSaas, fixture)
    await restoreFixture(fixture)
    await fakeSaas.close()
  } catch (error) {
    try {
      await restoreFixture(fixture)
    } catch (restoreError) {
      printResult('FAIL', 'restore local protocol fixture', restoreError.message)
    }
    if (fakeSaas) await fakeSaas.close()
    throw error
  }
}
