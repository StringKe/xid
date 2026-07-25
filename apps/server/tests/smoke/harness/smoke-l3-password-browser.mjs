#!/usr/bin/env node

import { argon2id } from '@noble/hashes/argon2.js'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { setNodeDependencies } from 'xml-core'
import { Application, Parse, SignedXml, Stringify } from 'xmldsigjs'
import xpath from 'xpath'
import { parseD1Json } from './d1-json.mjs'
import { closeChromeAndRemoveProfile } from './chrome-cleanup.mjs'
import { createSamlPostPayload, SAML_POST_PAGE } from './saml-post-form.mjs'
import { trimTrailingSlashes } from '../../../../../tests/helpers/url.mjs'

const DEFAULT_BASE_URL = 'http://localhost:5173'
const DEFAULT_PASSWORD = 'LocalL3Platform123!'
const CHROME_PATH =
  process.env.XID_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const baseUrl = trimTrailingSlashes(process.env.XID_L3_BASE_URL ?? DEFAULT_BASE_URL)
const adminEmail = (process.env.XID_L3_ADMIN_EMAIL ?? 'admin@localhost.test').toLowerCase()
const adminPassword = process.env.XID_L3_ADMIN_PASSWORD ?? DEFAULT_PASSWORD
const smokePersistPath = process.env.XID_SMOKE_PERSIST_PATH

if (smokePersistPath === undefined || smokePersistPath.length === 0) {
  throw new Error('XID_SMOKE_PERSIST_PATH missing')
}
const socialProvider = 'localoidc'
const SIGN_IN_PATH = '/sign-in?continue=%2Fconsole&locale=en'
const socialEmail = (
  process.env.XID_L3_SOCIAL_EMAIL ?? `social-${Date.now()}@localhost.test`
).toLowerCase()
const enterpriseConnectionId = 'conn_l3_enterprise_oidc'
const enterpriseDomain = 'sso.localhost.test'
const enterpriseEmail = (
  process.env.XID_L3_ENTERPRISE_EMAIL ?? `sso-${Date.now()}@${enterpriseDomain}`
).toLowerCase()
const samlConnectionId = 'conn_l3_enterprise_saml'
const samlDomain = 'saml.localhost.test'
const samlEmail = (
  process.env.XID_L3_SAML_EMAIL ?? `saml-${Date.now()}@${samlDomain}`
).toLowerCase()

const ARGON2_MEMORY_KB = 65536
const ARGON2_ITERATIONS = 3
const ARGON2_HASH_LEN = 32
const ARGON2_PARALLELISM = 1
const SAML_IDP_ENTITY_ID = 'https://idp.example.com/metadata'
const SAML_IDP_CERT_B64 = process.env.XID_L3_SAML_IDP_CERT_B64
const SAML_ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'
const SAML_PROTOCOL_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'

if (!SAML_IDP_CERT_B64) throw new Error('XID_L3_SAML_IDP_CERT_B64 missing')

Application.setEngine('webcrypto', crypto)
setNodeDependencies({ DOMParser, XMLSerializer, xpath })

function printResult(status, name, detail) {
  process.stdout.write(`${status} ${name}${detail ? ` ${detail}` : ''}\n`)
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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

function base64EncodeString(value) {
  return Buffer.from(value, 'utf8').toString('base64')
}

function b64ToBytes(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}

function readSamlIdpKeyPkcs8() {
  const key = process.env.XID_L3_SAML_IDP_KEY_PKCS8_B64
  if (!key) throw new Error('XID_L3_SAML_IDP_KEY_PKCS8_B64 missing')
  return b64ToBytes(key)
}

function derToP1363(signature) {
  if (signature.byteLength === 64) return signature
  if (signature[0] !== 0x30) throw new Error('invalid ECDSA signature format')
  let offset = 2
  const coords = []
  for (let index = 0; index < 2; index++) {
    if (signature[offset] !== 0x02) throw new Error('invalid ECDSA signature integer')
    const len = signature[offset + 1]
    const start = offset + 2
    const end = start + len
    if (end > signature.length) throw new Error('invalid ECDSA signature length')
    let valueStart = start
    while (valueStart < end - 1 && signature[valueStart] === 0) valueStart++
    const coord = new Uint8Array(32)
    const value = signature.subarray(valueStart, end)
    if (value.byteLength > 32) throw new Error('invalid ECDSA coordinate length')
    coord.set(value, 32 - value.byteLength)
    coords.push(coord)
    offset = end
  }
  const out = new Uint8Array(64)
  out.set(coords[0], 0)
  out.set(coords[1], 32)
  return out
}

async function exportPublicJwk(publicKey, kid) {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey)
  return { ...jwk, kid, use: 'sig', alg: 'ES256' }
}

async function signJwt(input, signingKey) {
  const header = { typ: 'JWT', ...input.header }
  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
    JSON.stringify(input.payload),
  )}`
  const signature = derToP1363(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signingKey,
        new TextEncoder().encode(signingInput),
      ),
    ),
  )
  return `${signingInput}.${base64UrlEncode(signature)}`
}

async function importSamlIdpSigningKey() {
  return crypto.subtle.importKey(
    'pkcs8',
    readSamlIdpKeyPkcs8(),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

function buildSamlResponseXml({ audience, recipient, email }) {
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  const responseId = `_resp_${crypto.randomUUID().replaceAll('-', '')}`
  const assertionId = `_assert_${crypto.randomUUID().replaceAll('-', '')}`
  const assertion = [
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now}">`,
    `<saml:Issuer>${SAML_IDP_ENTITY_ID}</saml:Issuer>`,
    `<saml:Subject>`,
    `<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress">${email}</saml:NameID>`,
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">`,
    `<saml:SubjectConfirmationData Recipient="${recipient}" NotOnOrAfter="${expires}"/>`,
    `</saml:SubjectConfirmation>`,
    `</saml:Subject>`,
    `<saml:Conditions NotBefore="${now}" NotOnOrAfter="${expires}">`,
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>`,
    `</saml:Conditions>`,
    `<saml:AttributeStatement>`,
    `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>`,
    `<saml:Attribute Name="firstName"><saml:AttributeValue>Local</saml:AttributeValue></saml:Attribute>`,
    `<saml:Attribute Name="groups"><saml:AttributeValue>Engineering</saml:AttributeValue></saml:Attribute>`,
    `</saml:AttributeStatement>`,
    `</saml:Assertion>`,
  ].join('')
  return [
    `<samlp:Response xmlns:samlp="${SAML_PROTOCOL_NS}" xmlns:saml="${SAML_ASSERTION_NS}"`,
    ` ID="${responseId}" Version="2.0" IssueInstant="${now}">`,
    `<saml:Issuer>${SAML_IDP_ENTITY_ID}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`,
    assertion,
    `</samlp:Response>`,
  ].join('')
}

function firstChildByLocalName(parent, localName) {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1 && node.localName === localName) return node
  }
  return null
}

async function signSamlElement(doc, target, key) {
  const id = target.getAttribute('ID') ?? ''
  const signedXml = new SignedXml(doc)
  await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, key, doc, {
    references: [{ uri: `#${id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
  })
  const sig = signedXml.GetXml()
  if (!sig) throw new Error('SAML signature not produced')
  target.appendChild(sig)
}

async function buildSignedSamlResponse(input) {
  const key = await importSamlIdpSigningKey()
  const doc = Parse(buildSamlResponseXml(input))
  const assertion = firstChildByLocalName(doc.documentElement, 'Assertion')
  if (!assertion) throw new Error('SAML assertion not found')
  await signSamlElement(doc, assertion, key)
  await signSamlElement(doc, doc.documentElement, key)
  return Stringify(doc)
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

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const normalized = value.toUpperCase().replaceAll('=', '')
  let bits = 0
  let current = 0
  const out = []
  for (const char of normalized) {
    const idx = alphabet.indexOf(char)
    if (idx < 0) throw new Error('invalid base32 character in TOTP secret')
    current = (current << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((current >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

async function hotp(secretBytes, counter) {
  const msg = new Uint8Array(8)
  let value = BigInt(counter)
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(value & 0xffn)
    value >>= 8n
  }
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))
  const offset = sig[19] & 0x0f
  const code =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff)
  return String(code % 1000000).padStart(6, '0')
}

function currentTotpCode(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30)
  return hotp(base32Decode(secret), counter)
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

function parseDevVars() {
  const { XID_SMOKE_KEK: KEK, XID_SMOKE_PEPPER: PEPPER } = process.env
  if (!KEK || !PEPPER)
    throw new Error('XID smoke KEK and PEPPER must be provided through the process environment')
  return { KEK, PEPPER }
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

async function d1(command, name) {
  const stdout = await run(
    'pnpm',
    [
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

async function fetchText(path, options = {}) {
  const headers = new Headers(options.headers)
  if (options.cookie) headers.set('cookie', options.cookie)
  const res = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' })
  const text = await res.text()
  return { res, text }
}

function parseJson(text, name) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} returned non-json body: ${text.slice(0, 200)}`)
  }
}

function isAuthDiagnosticUrl(value) {
  try {
    const url = new URL(value)
    return (
      url.pathname === '/authorize' ||
      url.pathname === '/sign-in' ||
      url.pathname === '/console' ||
      url.pathname === '/v1/me' ||
      url.pathname.startsWith('/auth/')
    )
  } catch {
    return false
  }
}

function redactDiagnosticUrl(value) {
  const url = new URL(value)
  if (url.searchParams.size === 0) return `${url.origin}${url.pathname}`
  const keys = Array.from(url.searchParams.keys()).sort()
  return `${url.origin}${url.pathname}?query=${keys.join(',')}`
}

function cookieNames(value) {
  if (typeof value !== 'string' || value.length === 0) return []
  return value
    .split(/;\s*|,\s*(?=[^;,]+=)/)
    .map((part) => part.split('=')[0]?.trim())
    .filter((name) => name?.startsWith('__Host-xid.'))
}

async function collectJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return Object.fromEntries(new URLSearchParams(text))
}

function localOidcSubject(clientId) {
  return clientId === 'local-enterprise-client'
    ? {
        code: 'local-enterprise-code',
        aud: 'local-enterprise-client',
        sub: 'local-enterprise-user-1',
        email: enterpriseEmail,
        name: 'Local Enterprise User',
        givenName: 'Local',
        familyName: 'Enterprise',
        groups: ['Engineering'],
      }
    : {
        code: 'local-social-code',
        aud: 'local-social-client',
        sub: 'local-social-user-1',
        email: socialEmail,
        name: 'Local Social User',
        givenName: 'Local',
        familyName: 'Social',
        groups: [],
      }
}

async function startLocalOidcProvider(expectedClientSecret) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const kid = `localoidc-${Date.now()}`
  const jwk = await exportPublicJwk(pair.publicKey, kid, 'ES256')
  let issuer = ''
  const lastAuthorize = new Map()
  const lastTokenRequest = new Map()

  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', issuer || 'http://127.0.0.1')
      if (url.pathname === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
          }),
        )
        return
      }

      if (url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri')
        const clientId = url.searchParams.get('client_id')
        const state = url.searchParams.get('state')
        const nonce = url.searchParams.get('nonce')
        const codeChallenge = url.searchParams.get('code_challenge')
        const codeChallengeMethod = url.searchParams.get('code_challenge_method')
        if (
          !redirectUri ||
          !clientId ||
          !state ||
          !nonce ||
          !codeChallenge ||
          codeChallengeMethod !== 'S256'
        ) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('invalid authorize request')
          return
        }
        const subject = localOidcSubject(clientId)
        lastAuthorize.set(clientId, { nonce, codeChallenge, redirectUri })
        const callback = new URL(redirectUri)
        callback.searchParams.set('code', subject.code)
        callback.searchParams.set('state', state)
        res.writeHead(302, { location: callback.toString() })
        res.end()
        return
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        const body = await collectJsonBody(req)
        const clientId = String(body['client_id'] || '')
        const subject = localOidcSubject(clientId)
        const authorize = lastAuthorize.get(clientId)
        lastTokenRequest.set(clientId, body)
        if (
          body['grant_type'] !== 'authorization_code' ||
          body['code'] !== subject.code ||
          (clientId === 'local-social-client' && body['client_secret'] !== expectedClientSecret) ||
          typeof body['code_verifier'] !== 'string' ||
          body['code_verifier'].length < 40 ||
          !authorize ||
          body['redirect_uri'] !== authorize.redirectUri
        ) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        const now = Math.floor(Date.now() / 1000)
        const idToken = await signJwt(
          {
            header: { alg: 'ES256', kid },
            payload: {
              iss: issuer,
              aud: subject.aud,
              sub: subject.sub,
              email: subject.email,
              email_verified: true,
              name: subject.name,
              given_name: subject.givenName,
              family_name: subject.familyName,
              groups: subject.groups,
              nonce: authorize.nonce,
              iat: now,
              exp: now + 300,
            },
          },
          pair.privateKey,
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            access_token: 'local-access-token',
            token_type: 'Bearer',
            expires_in: 300,
            id_token: idToken,
          }),
        )
        return
      }

      if (url.pathname === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ keys: [jwk] }))
        return
      }

      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    } catch (error) {
      console.error('local OIDC provider request failed', error)
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('internal provider error')
    }
  })

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('local oidc provider did not bind to a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
  issuer = `http://${localProviderHost()}:${port}`
  return {
    issuer,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve))
    },
    state: () => ({
      social: {
        lastAuthorize: lastAuthorize.get('local-social-client') ?? null,
        lastTokenRequest: lastTokenRequest.get('local-social-client') ?? null,
      },
      enterprise: {
        lastAuthorize: lastAuthorize.get('local-enterprise-client') ?? null,
        lastTokenRequest: lastTokenRequest.get('local-enterprise-client') ?? null,
      },
    }),
  }
}

async function startLocalSamlProvider() {
  let issuer = ''
  const state = {
    lastRequest: null,
    lastRelayState: null,
    lastAcsUrl: null,
    pendingPostPayload: null,
  }

  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', issuer || 'http://127.0.0.1')
      if (url.pathname === '/sso') {
        const samlRequest = url.searchParams.get('SAMLRequest')
        const relayState = url.searchParams.get('RelayState')
        if (!samlRequest) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('missing SAMLRequest')
          return
        }
        const requestXml = inflateRawSync(Buffer.from(samlRequest, 'base64')).toString('utf8')
        const acsMatch = requestXml.match(/AssertionConsumerServiceURL="([^"]+)"/)
        const acsUrl = acsMatch?.[1]
        if (!acsUrl) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('missing ACS URL')
          return
        }
        const expectedAcsUrl = `${baseUrl}/sso/saml/${samlConnectionId}/acs`
        if (acsUrl !== expectedAcsUrl) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('invalid ACS URL')
          return
        }
        state.lastRequest = requestXml
        state.lastRelayState = relayState
        state.lastAcsUrl = acsUrl
        const responseXml = await buildSignedSamlResponse({
          audience: `${baseUrl}/saml/${samlConnectionId}`,
          recipient: acsUrl,
          email: samlEmail,
        })
        const samlResponse = base64EncodeString(responseXml)
        state.pendingPostPayload = createSamlPostPayload({
          acsUrl,
          expectedAcsUrl,
          samlResponse,
          relayState,
        })
        res.writeHead(303, { location: '/saml-post' })
        res.end()
        return
      }

      if (url.pathname === '/saml-post') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(SAML_POST_PAGE)
        return
      }

      if (url.pathname === '/saml-post-payload') {
        const payload = state.pendingPostPayload
        state.pendingPostPayload = null
        if (payload === null) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'SAML response unavailable' }))
          return
        }
        res.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        })
        res.end(JSON.stringify(payload))
        return
      }

      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    } catch (error) {
      console.error('local SAML provider request failed', error)
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('internal provider error')
    }
  })

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('local saml provider did not bind to a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
  issuer = `http://${localProviderHost()}:${port}`
  return {
    ssoUrl: `${issuer}/sso`,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve))
    },
    state: () => ({ ...state }),
  }
}

function localProviderHost() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
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

async function prepareLocalPassword() {
  const vars = parseDevVars()
  if (!vars.PEPPER) throw new Error('XID smoke PEPPER missing from the process environment')
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
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${Date.now()} WHERE id = ${sqlString(row.tenant_id)};`,
    'enable local password policy',
  )

  const passwordHash = await hashPassword(adminPassword, vars.PEPPER)
  const reuseTag = await passwordReuseTag(adminPassword, vars.PEPPER)
  await d1(
    `INSERT INTO passwords (id, tenant_id, user_id, hash, algo, pepper_version, reuse_tag, breached, created_at, updated_at) VALUES (${sqlString(`pw_l3_${row.user_id}`)}, ${sqlString(row.tenant_id)}, ${sqlString(row.user_id)}, ${sqlString(passwordHash.hash)}, ${sqlString(passwordHash.algo)}, ${passwordHash.pepperVersion}, ${sqlString(reuseTag)}, 0, ${Date.now()}, ${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, algo = excluded.algo, pepper_version = excluded.pepper_version, reuse_tag = excluded.reuse_tag, updated_at = excluded.updated_at;`,
    'upsert local password',
  )
  printResult('PASS', 'local password fixture', `user=${row.user_id}`)
  return { tenantId: row.tenant_id, userId: row.user_id, originalMetadata, pepper: vars.PEPPER }
}

async function prepareLocalSocialProvider(fixture, oidcIssuer) {
  const rows = await d1(
    `SELECT private_metadata AS private_metadata FROM organizations WHERE id = ${sqlString(fixture.tenantId)} LIMIT 1;`,
    'load local organization metadata',
  )
  const row = rows[0]
  if (!row) throw new Error(`organization not found: ${fixture.tenantId}`)
  const metadata = JSON.parse(row.private_metadata || '{}')
  metadata.socialProviders = {
    ...(metadata.socialProviders ?? {}),
    [socialProvider]: {
      authorizationEndpoint: `${oidcIssuer}/authorize`,
      tokenEndpoint: `${oidcIssuer}/token`,
      clientId: 'local-social-client',
      clientSecretRef: 'PEPPER',
      scopes: ['openid', 'email', 'profile'],
      usesPkce: true,
      issuer: oidcIssuer,
      jwksUri: `${oidcIssuer}/jwks`,
      redirectUris: ['/console', '/account'],
      enabled: true,
      allowLogin: true,
      allowUserCreation: true,
      requireVerifiedEmail: true,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    },
  }
  await cleanupLocalSocialUser(fixture.tenantId)
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'enable local social provider policy',
  )
  printResult('PASS', 'local social provider fixture', `provider=${socialProvider}`)
}

async function cleanupLocalSocialUser(tenantId) {
  const users = await d1(
    `SELECT users.id AS user_id FROM users JOIN user_emails ON user_emails.user_id = users.id WHERE users.tenant_id = ${sqlString(tenantId)} AND user_emails.email = ${sqlString(socialEmail)};`,
    'load local social smoke user',
  )
  for (const user of users) {
    const userId = user.user_id
    await d1(
      `DELETE FROM sessions WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local social sessions',
    )
    await d1(
      `DELETE FROM memberships WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local social memberships',
    )
    await d1(
      `DELETE FROM user_identities WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local social identities',
    )
    await d1(
      `DELETE FROM user_emails WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local social emails',
    )
    await d1(
      `DELETE FROM users WHERE tenant_id = ${sqlString(tenantId)} AND id = ${sqlString(userId)};`,
      'delete local social user',
    )
  }
}

async function prepareLocalEnterpriseSso(fixture, oidcIssuer) {
  const rows = await d1(
    `SELECT private_metadata AS private_metadata FROM organizations WHERE id = ${sqlString(fixture.tenantId)} LIMIT 1;`,
    'load local organization metadata for enterprise sso',
  )
  const row = rows[0]
  if (!row) throw new Error(`organization not found: ${fixture.tenantId}`)
  const metadata = JSON.parse(row.private_metadata || '{}')
  metadata.hostedAuth = {
    ...(metadata.hostedAuth ?? {}),
    enterpriseSso: {
      enabled: true,
      allowLogin: true,
      allowJitUserCreation: true,
      domainDiscovery: true,
      allowedEmailDomains: [enterpriseDomain],
      blockedEmailDomains: [],
    },
  }
  await cleanupLocalEnterpriseSso(fixture.tenantId)
  await d1(
    `INSERT INTO organization_domains (id, tenant_id, org_id, domain, verification_method, verification_token, verification_status, is_wildcard, enrollment_mode, verified_at, created_at, updated_at) VALUES (${sqlString(`dom_l3_${enterpriseConnectionId}`)}, ${sqlString(fixture.tenantId)}, ${sqlString(fixture.tenantId)}, ${sqlString(enterpriseDomain)}, 'dns_txt', 'local-l3', 'verified', 0, 'sso_required', ${Date.now()}, ${Date.now()}, ${Date.now()});`,
    'insert local enterprise domain',
  )
  await d1(
    `INSERT INTO sso_connections (id, tenant_id, org_id, protocol, oidc_client_id, oidc_discovery_url, idp_certificates, want_authn_response_signed, want_assertions_signed, attribute_mapping, role_mapping, jit_enabled, status, created_at, updated_at) VALUES (${sqlString(enterpriseConnectionId)}, ${sqlString(fixture.tenantId)}, ${sqlString(fixture.tenantId)}, 'oidc', 'local-enterprise-client', ${sqlString(`${oidcIssuer}/.well-known/openid-configuration`)}, '[]', 1, 1, '{}', ${sqlString(JSON.stringify({ Engineering: 'admin' }))}, 1, 'active', ${Date.now()}, ${Date.now()});`,
    'insert local enterprise oidc connection',
  )
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'enable local enterprise sso policy',
  )
  printResult('PASS', 'local enterprise oidc fixture', `connection=${enterpriseConnectionId}`)
}

async function prepareLocalEnterpriseSamlSso(fixture, samlSsoUrl) {
  const rows = await d1(
    `SELECT private_metadata AS private_metadata FROM organizations WHERE id = ${sqlString(fixture.tenantId)} LIMIT 1;`,
    'load local organization metadata for enterprise saml',
  )
  const row = rows[0]
  if (!row) throw new Error(`organization not found: ${fixture.tenantId}`)
  const metadata = JSON.parse(row.private_metadata || '{}')
  metadata.hostedAuth = {
    ...(metadata.hostedAuth ?? {}),
    enterpriseSso: {
      enabled: true,
      allowLogin: true,
      allowJitUserCreation: true,
      domainDiscovery: true,
      allowedEmailDomains: [samlDomain],
      blockedEmailDomains: [],
    },
  }
  await cleanupLocalEnterpriseSamlSso(fixture.tenantId)
  await d1(
    `INSERT INTO organization_domains (id, tenant_id, org_id, domain, verification_method, verification_token, verification_status, is_wildcard, enrollment_mode, verified_at, created_at, updated_at) VALUES (${sqlString(`dom_l3_${samlConnectionId}`)}, ${sqlString(fixture.tenantId)}, ${sqlString(fixture.tenantId)}, ${sqlString(samlDomain)}, 'dns_txt', 'local-l3', 'verified', 0, 'sso_required', ${Date.now()}, ${Date.now()}, ${Date.now()});`,
    'insert local enterprise saml domain',
  )
  await d1(
    `INSERT INTO sso_connections (id, tenant_id, org_id, protocol, idp_entity_id, idp_sso_url, idp_certificates, want_authn_response_signed, want_assertions_signed, attribute_mapping, role_mapping, jit_enabled, status, created_at, updated_at) VALUES (${sqlString(samlConnectionId)}, ${sqlString(fixture.tenantId)}, ${sqlString(fixture.tenantId)}, 'saml', ${sqlString(SAML_IDP_ENTITY_ID)}, ${sqlString(samlSsoUrl)}, ${sqlString(JSON.stringify([SAML_IDP_CERT_B64]))}, 1, 1, '{}', ${sqlString(JSON.stringify({ Engineering: 'admin' }))}, 1, 'active', ${Date.now()}, ${Date.now()});`,
    'insert local enterprise saml connection',
  )
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'enable local enterprise saml policy',
  )
  printResult('PASS', 'local enterprise saml fixture', `connection=${samlConnectionId}`)
}

async function cleanupLocalEnterpriseSso(tenantId) {
  const users = await d1(
    `SELECT users.id AS user_id FROM users JOIN user_emails ON user_emails.user_id = users.id WHERE users.tenant_id = ${sqlString(tenantId)} AND user_emails.email = ${sqlString(enterpriseEmail)};`,
    'load local enterprise smoke user',
  )
  for (const user of users) {
    const userId = user.user_id
    await d1(
      `DELETE FROM sessions WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local enterprise sessions',
    )
    await d1(
      `DELETE FROM memberships WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local enterprise memberships',
    )
    await d1(
      `DELETE FROM user_identities WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local enterprise identities',
    )
    await d1(
      `DELETE FROM user_emails WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local enterprise emails',
    )
    await d1(
      `DELETE FROM users WHERE tenant_id = ${sqlString(tenantId)} AND id = ${sqlString(userId)};`,
      'delete local enterprise user',
    )
  }
  await d1(
    `DELETE FROM sso_connections WHERE tenant_id = ${sqlString(tenantId)} AND id = ${sqlString(enterpriseConnectionId)};`,
    'delete local enterprise oidc connection',
  )
  await d1(
    `DELETE FROM organization_domains WHERE tenant_id = ${sqlString(tenantId)} AND domain = ${sqlString(enterpriseDomain)};`,
    'delete local enterprise domain',
  )
}

async function cleanupLocalEnterpriseSamlSso(tenantId) {
  const users = await d1(
    `SELECT users.id AS user_id FROM users JOIN user_emails ON user_emails.user_id = users.id WHERE users.tenant_id = ${sqlString(tenantId)} AND user_emails.email = ${sqlString(samlEmail)};`,
    'load local enterprise saml smoke user',
  )
  for (const user of users) {
    const userId = user.user_id
    await d1(
      `DELETE FROM sessions WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local enterprise saml sessions',
    )
    await d1(
      `DELETE FROM memberships WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local enterprise saml memberships',
    )
    await d1(
      `DELETE FROM user_identities WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local enterprise saml identities',
    )
    await d1(
      `DELETE FROM user_emails WHERE tenant_id = ${sqlString(tenantId)} AND user_id = ${sqlString(userId)};`,
      'delete local enterprise saml emails',
    )
    await d1(
      `DELETE FROM users WHERE tenant_id = ${sqlString(tenantId)} AND id = ${sqlString(userId)};`,
      'delete local enterprise saml user',
    )
  }
  await d1(
    `DELETE FROM sso_connections WHERE tenant_id = ${sqlString(tenantId)} AND id = ${sqlString(samlConnectionId)};`,
    'delete local enterprise saml connection',
  )
  await d1(
    `DELETE FROM organization_domains WHERE tenant_id = ${sqlString(tenantId)} AND domain = ${sqlString(samlDomain)};`,
    'delete local enterprise saml domain',
  )
}

async function cleanupLocalMfaSelfService(fixture) {
  if (!fixture?.tenantId || !fixture?.userId) return
  await d1(
    `DELETE FROM backup_codes WHERE tenant_id = ${sqlString(fixture.tenantId)} AND user_id = ${sqlString(fixture.userId)};`,
    'delete local mfa backup codes',
  )
  await d1(
    `DELETE FROM mfa_factors WHERE tenant_id = ${sqlString(fixture.tenantId)} AND user_id = ${sqlString(fixture.userId)} AND factor_type = 'totp';`,
    'delete local mfa totp factors',
  )
  printResult('PASS', 'cleanup local mfa self-service fixture', `user=${fixture.userId}`)
}

async function restoreMetadata(fixture) {
  if (!fixture) return
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(fixture.originalMetadata)}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'restore local hosted auth policy',
  )
  await cleanupLocalSocialUser(fixture.tenantId)
  await cleanupLocalEnterpriseSso(fixture.tenantId)
  await cleanupLocalEnterpriseSamlSso(fixture.tenantId)
  await cleanupLocalMfaSelfService(fixture)
  printResult('PASS', 'restore local hosted auth policy')
}

async function verifyPasswordAuthConfig() {
  const { res, text } = await fetchText('/auth/config')
  if (res.status !== 200) throw new Error(`/auth/config failed http=${res.status} body=${text}`)
  const body = parseJson(text, '/auth/config')
  if (body?.methods?.password?.enabled !== true || body?.methods?.password?.allowLogin !== true) {
    throw new Error(`/auth/config password policy mismatch: ${text}`)
  }
  printResult('PASS', 'password auth config', `http=${res.status}`)
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate Chrome debug port')))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function waitForVersion(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      // Chrome is still starting.
    }
    await delay(250)
  }
  throw new Error('Chrome did not expose CDP before timeout')
}

async function createTab(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  if (!res.ok) throw new Error(`create Chrome tab failed http=${res.status}`)
  const target = await res.json()
  if (!target.webSocketDebuggerUrl) throw new Error('Chrome tab has no CDP websocket URL')
  return target.webSocketDebuggerUrl
}

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.networkLog = []
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => this.handleMessage(event))
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    await this.send('Log.enable')
  }

  handleMessage(event) {
    const message = JSON.parse(event.data)
    if (message.id) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method} failed`))
      else pending.resolve(message.result)
      return
    }
    if (
      message.method === 'Runtime.exceptionThrown' ||
      message.method === 'Log.entryAdded' ||
      message.method === 'Runtime.consoleAPICalled'
    ) {
      this.events.push(message)
    }
    if (message.method === 'Network.requestWillBeSent') {
      const url = String(message.params?.request?.url ?? '')
      if (isAuthDiagnosticUrl(url)) {
        this.networkLog.push({
          requestId: message.params.requestId,
          url: redactDiagnosticUrl(url),
          method: message.params.request?.method,
          requestCookieNames: cookieNames(message.params?.request?.headers?.Cookie),
        })
      }
    }
    if (message.method === 'Network.responseReceived') {
      const requestId = message.params?.requestId
      const row = this.networkLog.find((entry) => entry.requestId === requestId)
      if (row) {
        row.status = message.params?.response?.status
        row.mimeType = message.params?.response?.mimeType
      }
    }
    if (message.method === 'Network.responseReceivedExtraInfo') {
      const requestId = message.params?.requestId
      const row = this.networkLog.find((entry) => entry.requestId === requestId)
      if (row) {
        const headers = message.params?.headers ?? {}
        const setCookie = headers['set-cookie'] ?? headers['Set-Cookie']
        row.setCookieNames = cookieNames(setCookie)
      }
    }
    if (message.method === 'Network.loadingFailed') {
      const requestId = message.params?.requestId
      const row = this.networkLog.find((entry) => entry.requestId === requestId)
      if (row) {
        row.failed = true
        row.errorText = message.params.errorText
      }
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate exception: ${JSON.stringify(result.exceptionDetails)}`)
    }
    return result.result.value
  }

  async waitFor(fn, timeoutMs, name) {
    const deadline = Date.now() + timeoutMs
    const source = `(${fn.toString()})()`
    while (Date.now() < deadline) {
      if ((await this.evaluate(source)) === true) return
      await delay(250)
    }
    throw new Error(`${name} timed out`)
  }

  async navigate(path) {
    this.events = []
    await this.send('Page.navigate', { url: `${baseUrl}${path}` })
    await this.waitFor(() => document.readyState === 'complete', 15_000, `load ${path}`)
    await this.waitFor(() => document.body.innerText.trim().length > 0, 15_000, `body ${path}`)
  }

  async setPreferredLocale(locale) {
    await this.evaluate(`(() => {
      localStorage.setItem('xid.locale', ${JSON.stringify(locale)});
      document.documentElement.setAttribute('lang', ${JSON.stringify(locale)});
      return true;
    })()`)
  }

  async clickVisibleButton(label) {
    const clicked = await this.evaluate(`(() => {
      const label = ${JSON.stringify(label)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
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
      const node = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"]'))
        .find((item) => isVisible(item) && !item.disabled && normalize(item.textContent) === label);
      if (!node) return false;
      node.click();
      return true;
    })()`)
    if (clicked !== true) throw new Error(`visible enabled button not found: ${label}`)
  }

  async setVisibleInputValue(selector, value) {
    const updated = await this.evaluate(`(() => {
      const selector = ${JSON.stringify(selector)};
      const value = ${JSON.stringify(value)};
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
      const input = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      input.focus();
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    if (updated !== true) throw new Error(`visible input not found: ${selector}`)
  }

  async submitVisibleFormContaining(text) {
    const submitted = await this.evaluate(`(() => {
      const text = ${JSON.stringify(text)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
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
      const form = Array.from(document.querySelectorAll('form'))
        .find((item) => isVisible(item) && normalize(item.textContent).includes(text));
      if (!form) return false;
      form.requestSubmit();
      return true;
    })()`)
    if (submitted !== true) throw new Error(`visible form not found: ${text}`)
  }

  async sessionCookieHeader() {
    const result = await this.send('Network.getCookies', { urls: [`${baseUrl}/`] })
    const pairs = (result.cookies ?? [])
      .filter((cookie) => String(cookie.name).startsWith('__Host-xid.rt.'))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
    if (pairs.length === 0) throw new Error('Chrome did not store __Host-xid.rt.* cookie')
    return pairs.join('; ')
  }

  async sessionCookieSummary() {
    const result = await this.send('Network.getCookies', { urls: [`${baseUrl}/`] })
    return (result.cookies ?? [])
      .filter((cookie) => String(cookie.name).startsWith('__Host-xid.rt.'))
      .map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      }))
  }

  authNetworkLog() {
    return this.networkLog.slice(-30)
  }

  async browserMe() {
    return await this.evaluate(`fetch('/v1/me', { credentials: 'include' }).then(async (res) => ({
      status: res.status,
      body: await res.text(),
    }))`)
  }

  async clearSessionCookies() {
    const result = await this.send('Network.getCookies', { urls: [`${baseUrl}/`] })
    const cookies = (result.cookies ?? []).filter((cookie) =>
      String(cookie.name).startsWith('__Host-xid.rt.'),
    )
    for (const cookie of cookies) {
      await this.send('Network.deleteCookies', {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      })
    }
  }

  async snapshot() {
    return await this.evaluate(`({
      href: location.href,
      pathname: location.pathname,
      text: document.body.innerText,
      hasPlaceholderHref: document.querySelector('a[href="__link__"]') !== null,
      badClass: Array.from(document.querySelectorAll('[class]')).some((node) => {
        const value = node.getAttribute('class') || '';
        return value.includes('=>') || value.includes('isActive') || value.includes('function');
      }),
      htmlHasFunctionClass: document.documentElement.outerHTML.includes('e=>n(') ||
        document.documentElement.outerHTML.includes('class="e=>'),
    })`)
  }

  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close()
  }
}

async function withChrome(fn) {
  const port = await freePort()
  const profileDir = await mkdtemp(join(tmpdir(), 'xid-l3-chrome-'))
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--disable-gpu',
      '--lang=en-US',
      '--no-first-run',
      '--no-default-browser-check',
      // CI runner 的 /dev/shm 只有 64MB,不关掉共享内存后端 renderer 会随机 OOM
      '--disable-dev-shm-usage',
      // 关掉与测试无关的后台流量与系统钥匙串访问,避免 CI 上的偶发挂起和噪声
      '--disable-background-networking',
      '--disable-sync',
      '--password-store=basic',
      '--use-mock-keychain',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    // 主进程成为进程组 leader,清理时才能连 renderer / GPU / crashpad 一起杀(见 chrome-cleanup.mjs)
    { detached: process.platform !== 'win32' },
  )

  let stderr = ''
  let launchError = null
  let exitDetails = null
  chrome.once('error', (error) => {
    launchError = error
  })
  chrome.once('exit', (code, signal) => {
    exitDetails = { code, signal }
  })
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await waitForVersion(port)
    const page = new CdpPage(await createTab(port))
    await page.connect()
    try {
      return await fn(page)
    } finally {
      await page.close()
    }
  } catch (error) {
    if (stderr) process.stderr.write(stderr)
    const details = [
      launchError?.message,
      exitDetails ? `exit code=${exitDetails.code} signal=${exitDetails.signal}` : null,
    ]
      .filter(Boolean)
      .join('; ')
    throw new Error(`${error.message}${details ? `; Chrome ${details}` : ''}`)
  } finally {
    await closeChromeAndRemoveProfile(chrome, profileDir)
  }
}

function assertNoConsoleErrors(page, name) {
  const failures = page.events.filter((event) => {
    if (event.method === 'Runtime.exceptionThrown') return true
    if (event.method === 'Log.entryAdded') {
      const level = event.params?.entry?.level
      const text = String(event.params?.entry?.text ?? '')
      const url = String(event.params?.entry?.url ?? '')
      const unauthenticatedMeProbe =
        url === `${baseUrl}/v1/me` &&
        text.includes('Failed to load resource') &&
        text.includes('status of 401')
      return level === 'error' && !unauthenticatedMeProbe
    }
    return false
  })
  if (failures.length > 0) {
    throw new Error(`${name} has console errors: ${JSON.stringify(failures).slice(0, 1000)}`)
  }
}

function assertNoConsoleDeadState(snapshot, name) {
  if (snapshot.text.includes('No organization selected')) {
    throw new Error(`${name} shows no organization selected`)
  }
  if (snapshot.text.includes('Choose an organization to continue')) {
    throw new Error(`${name} shows organization chooser after sign-in`)
  }
}

async function verifyBrowserPasswordSignIn(page) {
  await page.navigate(SIGN_IN_PATH)
  await page.setPreferredLocale('en')
  await page.waitFor(
    () =>
      document.body.innerText.includes('Password') && document.body.innerText.includes('Sign in'),
    15_000,
    'password sign-in UI',
  )
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
    adminEmail,
  )
  await page.setVisibleInputValue('input[type="password"]', adminPassword)
  await page.clickVisibleButton('Sign in')
  await page.waitFor(() => location.pathname.startsWith('/console'), 15_000, 'console redirect')
  await page.waitFor(() => document.body.innerText.includes('Sign out'), 15_000, 'signed in UI')

  const cookie = await page.sessionCookieHeader()
  const me = await page.browserMe()
  if (me.status !== 200) throw new Error(`/v1/me failed after browser password http=${me.status}`)
  const meBody = parseJson(me.body, '/v1/me')
  if (meBody.user?.email !== adminEmail) throw new Error(`/v1/me email mismatch: ${me.body}`)
  if (meBody.user?.instanceManager !== true) {
    throw new Error(`/v1/me instanceManager false: ${me.body}`)
  }
  if (!meBody.activeOrg?.id || !meBody.activeOrg?.name) {
    throw new Error(`/v1/me activeOrg missing: ${me.body}`)
  }

  const snapshot = await page.snapshot()
  if (!snapshot.pathname.startsWith('/console')) {
    throw new Error(`password default target mismatch: ${snapshot.href}`)
  }
  if (!snapshot.text.includes(adminEmail)) throw new Error('console missing signed in admin email')
  assertNoConsoleDeadState(snapshot, 'console')
  if (snapshot.text.includes('Sign in')) throw new Error('console shows Sign in after login')
  if (snapshot.hasPlaceholderHref) throw new Error('console has placeholder href')
  if (snapshot.badClass || snapshot.htmlHasFunctionClass)
    throw new Error('console has function class')
  assertNoConsoleErrors(page, 'browser password sign-in')
  printResult('PASS', 'browser password sign-in default console', `url=${snapshot.pathname}`)
  printResult('PASS', 'browser password cookie', cookie.split('; ')[0].split('=')[0])
  printResult('PASS', 'browser password me active organization', `org=${meBody.activeOrg.id}`)
  return meBody.activeOrg.id
}

async function fetchOrgEndpointFromBrowser(page, orgId, endpoint) {
  return await page.evaluate(`(async () => {
    const res = await fetch('/v1/organizations/${orgId}/${endpoint}', {
      credentials: 'include',
    })
    return { status: res.status, body: await res.json() }
  })()`)
}

async function verifyBrowserConsoleProviderControls(page, orgId, fixture) {
  await page.navigate('/console/org/auth-policy')
  await page.waitFor(
    () =>
      document.body.innerText.toLowerCase().includes('authentication policy') &&
      document.body.innerText.toLowerCase().includes('methods'),
    15_000,
    'auth policy console UI',
  )
  const authPolicy = await page.snapshot()
  const authPolicyText = authPolicy.text.toLowerCase()
  if (authPolicyText.includes('provider connections')) {
    throw new Error('auth policy page still renders provider connections')
  }
  if (authPolicyText.includes('client secret reference')) {
    throw new Error('auth policy page still renders social credential fields')
  }
  if (authPolicyText.includes('save social providers')) {
    throw new Error('auth policy page still renders social provider save action')
  }
  if (authPolicy.hasPlaceholderHref) throw new Error('auth policy page has placeholder href')
  if (authPolicy.badClass || authPolicy.htmlHasFunctionClass) {
    throw new Error('auth policy page has function class')
  }
  const authPolicyApi = await fetchOrgEndpointFromBrowser(page, orgId, 'auth-policy')
  if (authPolicyApi.status !== 200) {
    throw new Error(`auth policy api failed status=${authPolicyApi.status}`)
  }
  if (Object.prototype.hasOwnProperty.call(authPolicyApi.body, 'socialProviders')) {
    throw new Error('auth policy api still exposes socialProviders')
  }
  if (Object.prototype.hasOwnProperty.call(authPolicyApi.body, 'providerReadiness')) {
    throw new Error('auth policy api still exposes providerReadiness')
  }
  if (!authPolicyApi.body.hostedAuth || !authPolicyApi.body.deliveryChannelReadiness) {
    throw new Error('auth policy api missing hostedAuth or deliveryChannelReadiness')
  }

  await page.navigate('/console/org/social-providers')
  await page.waitFor(
    () =>
      document.body.innerText.toLowerCase().includes('social providers') &&
      document.body.innerText.toLowerCase().includes('provider connections'),
    15_000,
    'social providers console UI',
  )
  const providers = await page.snapshot()
  const providersText = providers.text.toLowerCase()
  for (const text of [
    'Client secret reference',
    'Authorization endpoint',
    'Save social providers',
  ]) {
    if (!providersText.includes(text.toLowerCase())) {
      throw new Error(`social providers page missing ${text}`)
    }
  }
  if (providers.hasPlaceholderHref) throw new Error('social providers page has placeholder href')
  if (providers.badClass || providers.htmlHasFunctionClass) {
    throw new Error('social providers page has function class')
  }
  const providersApi = await fetchOrgEndpointFromBrowser(page, orgId, 'social-providers')
  if (providersApi.status !== 200) {
    throw new Error(`social providers api failed status=${providersApi.status}`)
  }
  if (!providersApi.body.socialProviders) {
    throw new Error('social providers api missing socialProviders')
  }
  if (providersApi.body.socialProviders.localoidc?.clientSecretRef !== 'PEPPER') {
    throw new Error('social providers api did not preserve clientSecretRef name')
  }
  if (JSON.stringify(providersApi.body).includes(fixture.pepper)) {
    throw new Error('social providers api leaked secret value')
  }

  await page.navigate('/console/org/delivery-channels')
  await page.waitFor(
    () =>
      document.body.innerText.toLowerCase().includes('delivery channels') &&
      document.body.innerText.toLowerCase().includes('whatsapp provider') &&
      document.body.innerText.toLowerCase().includes('sms provider'),
    15_000,
    'delivery channels console UI',
  )
  const delivery = await page.snapshot()
  const deliveryText = delivery.text.toLowerCase()
  for (const text of [
    'Secret references',
    'Save delivery channels',
    'Twilio',
    'Vonage',
    'Infobip',
    'MessageBird',
  ]) {
    if (!deliveryText.includes(text.toLowerCase())) {
      throw new Error(`delivery channels page missing ${text}`)
    }
  }
  if (delivery.hasPlaceholderHref) throw new Error('delivery channels page has placeholder href')
  if (delivery.badClass || delivery.htmlHasFunctionClass) {
    throw new Error('delivery channels page has function class')
  }
  const deliveryApi = await fetchOrgEndpointFromBrowser(page, orgId, 'delivery-channels')
  if (deliveryApi.status !== 200) {
    throw new Error(`delivery channels api failed status=${deliveryApi.status}`)
  }
  if (
    !Array.isArray(deliveryApi.body?.whatsapp?.secretRefs) ||
    !Array.isArray(deliveryApi.body?.sms?.secretRefs)
  ) {
    throw new Error('delivery channels api missing secretRefs')
  }
  if (JSON.stringify(deliveryApi.body).includes(fixture.pepper)) {
    throw new Error('delivery channels api leaked secret value')
  }
  assertNoConsoleErrors(page, 'browser console provider controls')
  printResult('PASS', 'browser console provider controls')
}

async function verifyBrowserMfaSelfService(page, fixture) {
  await cleanupLocalMfaSelfService(fixture)
  await page.navigate('/account/security')
  await page.waitFor(
    () =>
      document.body.innerText.toLowerCase().includes('two-factor authentication') &&
      document.body.innerText.toLowerCase().includes('add authenticator app') &&
      document.body.innerText
        .toLowerCase()
        .includes('add an authenticator app before generating backup codes.') &&
      !Array.from(document.querySelectorAll('button')).some(
        (item) => String(item.textContent || '').trim() === 'Generate backup codes',
      ),
    15_000,
    'account security mfa UI',
  )

  const initial = await page.evaluate(`(() => ({
    text: document.body.innerText,
    hasBackupButton: Array.from(document.querySelectorAll('button')).some(
      (item) => String(item.textContent || '').trim() === 'Generate backup codes',
    ),
  }))()`)
  if (
    !initial.text.toLowerCase().includes('add an authenticator app before generating backup codes.')
  ) {
    throw new Error('mfa self-service missing strong-factor backup gate copy')
  }
  if (initial.hasBackupButton) {
    throw new Error('backup code button visible before strong MFA factor')
  }
  printResult('PASS', 'browser mfa backup button hidden without strong factor')

  await page.clickVisibleButton('Add authenticator app')
  await page.waitFor(
    () =>
      document.body.innerText.toLowerCase().includes('add this key to your authenticator app') &&
      document.querySelector('code')?.textContent?.trim().length > 0,
    15_000,
    'totp setup panel',
  )
  const secret = await page.evaluate(`document.querySelector('code')?.textContent?.trim() || ''`)
  const code = await currentTotpCode(secret)
  await page.setVisibleInputValue(
    'input[autocomplete="one-time-code"], input[inputmode="numeric"]',
    code,
  )
  await page.submitVisibleFormContaining('Authenticator code')
  await page.waitFor(
    () =>
      document.body.innerText.toLowerCase().includes('authenticator app added.') &&
      document.body.innerText.toLowerCase().includes('authenticator app (totp)') &&
      Array.from(document.querySelectorAll('button')).some(
        (item) => String(item.textContent || '').trim() === 'Generate backup codes',
      ),
    15_000,
    'totp activated in UI',
  )
  printResult('PASS', 'browser mfa totp setup and verify UI')

  const me = await page.browserMe()
  if (me.status !== 200) throw new Error(`/v1/me failed after mfa setup http=${me.status}`)
  const meBody = parseJson(me.body, '/v1/me after mfa')
  if (meBody.user?.hasMfa !== true) throw new Error(`/v1/me hasMfa false after TOTP: ${me.body}`)
  printResult('PASS', 'browser mfa me hasMfa', 'true')

  await page.clickVisibleButton('Generate backup codes')
  await page.waitFor(
    () =>
      document.body.innerText.toLowerCase().includes('store these backup codes now') &&
      document.querySelectorAll('ul li').length >= 10,
    15_000,
    'backup codes UI',
  )
  const backupState = await page.evaluate(`(() => {
    const codes = Array.from(document.querySelectorAll('ul li'))
      .map((item) => String(item.textContent || '').trim())
      .filter((value) => /^[A-Z2-9]{8}$/.test(value));
    return {
      count: codes.length,
      hasBackupFactor: document.body.innerText.toLowerCase().includes('backup codes (10 remaining)'),
      badClass: Array.from(document.querySelectorAll('[class]')).some((node) => {
        const value = node.getAttribute('class') || '';
        return value.includes('=>') || value.includes('isActive') || value.includes('function');
      }),
    };
  })()`)
  if (backupState.count !== 10 || backupState.hasBackupFactor !== true) {
    throw new Error(`backup codes UI mismatch: ${JSON.stringify(backupState)}`)
  }
  if (backupState.badClass) throw new Error('mfa account security has function class')
  assertNoConsoleErrors(page, 'browser mfa self-service')
  printResult('PASS', 'browser mfa backup codes UI', `count=${backupState.count}`)

  await cleanupLocalMfaSelfService(fixture)
}

async function verifyBrowserSocialSignIn(page, tenantId, providerState) {
  await page.clearSessionCookies()
  await page.navigate(SIGN_IN_PATH)
  await page.setPreferredLocale('en')
  await page.waitFor(
    () =>
      document.body.innerText.includes('localoidc') &&
      Array.from(document.querySelectorAll('button')).some((item) =>
        String(item.textContent || '').includes('localoidc'),
      ),
    15_000,
    'social provider button',
  )
  await page.clickVisibleButton(socialProvider)
  try {
    await page.waitFor(() => location.pathname === '/account', 20_000, 'social account portal')
  } catch (error) {
    const snapshot = await page.snapshot()
    const providerSnapshot = providerState()
    const detail = {
      href: snapshot.href,
      text: snapshot.text.slice(0, 400),
      authorizeSeen: Boolean(providerSnapshot.social.lastAuthorize),
      tokenSeen: Boolean(providerSnapshot.social.lastTokenRequest),
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(detail)}`,
    )
  }
  try {
    await page.waitFor(
      () => document.body.innerText.includes('Account settings'),
      15_000,
      'social signed in',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const me = await page.browserMe()
    const cookies = await page.sessionCookieSummary()
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify({
        href: snapshot.href,
        text: snapshot.text.slice(0, 400),
        meStatus: me.status,
        meBody: me.body.slice(0, 400),
        cookies,
        network: page.authNetworkLog(),
      })}`,
    )
  }

  const providerSnapshot = providerState()
  if (!providerSnapshot.social.lastAuthorize?.codeChallenge) {
    throw new Error('local social provider did not receive PKCE authorize request')
  }
  if (!providerSnapshot.social.lastTokenRequest?.['code_verifier']) {
    throw new Error('local social provider did not receive token exchange code_verifier')
  }

  const cookie = await page.sessionCookieHeader()
  const me = await page.browserMe()
  if (me.status !== 200) throw new Error(`/v1/me failed after browser social http=${me.status}`)
  const meBody = parseJson(me.body, '/v1/me')
  if (meBody.user?.email !== socialEmail)
    throw new Error(`/v1/me social email mismatch: ${me.body}`)
  if (!meBody.activeOrg?.id || meBody.activeOrg.id !== tenantId) {
    throw new Error(`/v1/me social activeOrg mismatch: ${me.body}`)
  }

  const identities = await d1(
    `SELECT COUNT(*) AS count FROM user_identities WHERE tenant_id = ${sqlString(tenantId)} AND identity_type = 'oauth' AND provider = ${sqlString(socialProvider)} AND provider_user_id = 'local-social-user-1' AND revoked_at IS NULL;`,
    'verify local social identity',
  )
  if (Number(identities[0]?.count ?? 0) !== 1) {
    throw new Error('local social identity not created')
  }
  const memberships = await d1(
    `SELECT memberships.role AS role FROM memberships JOIN users ON users.id = memberships.user_id JOIN user_emails ON user_emails.user_id = users.id WHERE memberships.tenant_id = ${sqlString(tenantId)} AND memberships.org_id = ${sqlString(tenantId)} AND memberships.status = 'active' AND user_emails.email = ${sqlString(socialEmail)} LIMIT 1;`,
    'verify local social membership',
  )
  if (memberships[0]?.role !== 'member') {
    throw new Error(`local social membership role mismatch: ${String(memberships[0]?.role)}`)
  }

  const snapshot = await page.snapshot()
  if (snapshot.pathname !== '/account') {
    throw new Error(`social default target mismatch: ${snapshot.href}`)
  }
  assertNoConsoleDeadState(snapshot, 'social account portal')
  if (snapshot.text.includes('Sign in')) {
    throw new Error('social account portal shows Sign in after login')
  }
  if (snapshot.hasPlaceholderHref) throw new Error('social account portal has placeholder href')
  if (snapshot.badClass || snapshot.htmlHasFunctionClass) {
    throw new Error('social account portal has function class')
  }
  assertNoConsoleErrors(page, 'browser social sign-in')
  printResult('PASS', 'browser social oauth default account portal', `provider=${socialProvider}`)
  printResult('PASS', 'browser social cookie', cookie.split('; ')[0].split('=')[0])
  printResult('PASS', 'browser social me active organization', `org=${meBody.activeOrg.id}`)
  printResult('PASS', 'browser social oidc provider exchange', 'pkce=true id_token=true')
  printResult('PASS', 'browser social member lands on account portal', 'role=member')
}

async function verifyBrowserEnterpriseOidcSso(page, tenantId, providerState) {
  await page.clearSessionCookies()
  await page.navigate(SIGN_IN_PATH)
  await page.setPreferredLocale('en')
  await page.waitFor(
    () =>
      document.body.innerText.includes('Continue with SSO') &&
      Array.from(document.querySelectorAll('button')).some(
        (item) => String(item.textContent || '').trim() === 'Continue with SSO',
      ),
    15_000,
    'enterprise sso UI',
  )
  const ssoVisible = await page.evaluate(`(() => {
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
    return Array.from(document.querySelectorAll('form[aria-label="Sign in with SSO"]')).some(isVisible);
  })()`)
  if (ssoVisible !== true) await page.clickVisibleButton('SSO')
  await page.setVisibleInputValue(
    'input[type="email"], input[autocomplete="email"]',
    enterpriseEmail,
  )
  await page.clickVisibleButton('Continue with SSO')
  try {
    await page.waitFor(
      () => location.pathname.startsWith('/console'),
      20_000,
      'enterprise sso console',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const providerSnapshot = providerState()
    const detail = {
      href: snapshot.href,
      text: snapshot.text.slice(0, 400),
      authorizeSeen: Boolean(providerSnapshot.enterprise.lastAuthorize),
      tokenSeen: Boolean(providerSnapshot.enterprise.lastTokenRequest),
      network: page.authNetworkLog(),
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(detail)}`,
    )
  }
  try {
    await page.waitFor(
      () => document.body.innerText.includes('Sign out'),
      15_000,
      'enterprise sso signed in',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const me = await page.browserMe()
    const cookies = await page.sessionCookieSummary()
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify({
        href: snapshot.href,
        text: snapshot.text.slice(0, 400),
        meStatus: me.status,
        meBody: me.body.slice(0, 400),
        cookies,
        network: page.authNetworkLog(),
      })}`,
    )
  }

  const providerSnapshot = providerState()
  if (!providerSnapshot.enterprise.lastAuthorize?.codeChallenge) {
    throw new Error('local enterprise provider did not receive PKCE authorize request')
  }
  if (!providerSnapshot.enterprise.lastTokenRequest?.['code_verifier']) {
    throw new Error('local enterprise provider did not receive token exchange code_verifier')
  }
  const redirectUri = providerSnapshot.enterprise.lastTokenRequest?.['redirect_uri']
  if (redirectUri !== `${baseUrl}/sso/oidc/${enterpriseConnectionId}/callback`) {
    throw new Error(`local enterprise provider redirect_uri mismatch: ${String(redirectUri)}`)
  }

  const cookie = await page.sessionCookieHeader()
  const me = await page.browserMe()
  if (me.status !== 200)
    throw new Error(`/v1/me failed after browser enterprise oidc http=${me.status}`)
  const meBody = parseJson(me.body, '/v1/me')
  if (meBody.user?.email !== enterpriseEmail)
    throw new Error(`/v1/me enterprise email mismatch: ${me.body}`)
  if (!meBody.activeOrg?.id || meBody.activeOrg.id !== tenantId) {
    throw new Error(`/v1/me enterprise activeOrg mismatch: ${me.body}`)
  }

  const identities = await d1(
    `SELECT COUNT(*) AS count FROM user_identities WHERE tenant_id = ${sqlString(tenantId)} AND identity_type = 'sso' AND provider = ${sqlString(enterpriseConnectionId)} AND provider_user_id = 'local-enterprise-user-1' AND revoked_at IS NULL;`,
    'verify local enterprise identity',
  )
  if (Number(identities[0]?.count ?? 0) !== 1) {
    throw new Error('local enterprise identity not created')
  }
  const memberships = await d1(
    `SELECT memberships.role AS role FROM memberships JOIN users ON users.id = memberships.user_id JOIN user_emails ON user_emails.user_id = users.id WHERE memberships.tenant_id = ${sqlString(tenantId)} AND memberships.org_id = ${sqlString(tenantId)} AND memberships.status = 'active' AND user_emails.email = ${sqlString(enterpriseEmail)} LIMIT 1;`,
    'verify local enterprise membership',
  )
  if (memberships[0]?.role !== 'admin') {
    throw new Error(`local enterprise role mapping mismatch: ${String(memberships[0]?.role)}`)
  }

  const snapshot = await page.snapshot()
  if (!snapshot.pathname.startsWith('/console')) {
    throw new Error(`enterprise default target mismatch: ${snapshot.href}`)
  }
  assertNoConsoleDeadState(snapshot, 'enterprise console')
  if (snapshot.text.includes('Sign in')) {
    throw new Error('enterprise console shows Sign in after login')
  }
  if (snapshot.hasPlaceholderHref) throw new Error('enterprise console has placeholder href')
  if (snapshot.badClass || snapshot.htmlHasFunctionClass) {
    throw new Error('enterprise console has function class')
  }
  assertNoConsoleErrors(page, 'browser enterprise oidc sign-in')
  printResult(
    'PASS',
    'browser enterprise oidc default console',
    `connection=${enterpriseConnectionId}`,
  )
  printResult('PASS', 'browser enterprise oidc cookie', cookie.split('; ')[0].split('=')[0])
  printResult(
    'PASS',
    'browser enterprise oidc me active organization',
    `org=${meBody.activeOrg.id}`,
  )
  printResult('PASS', 'browser enterprise oidc provider exchange', 'pkce=true id_token=true')
  printResult('PASS', 'browser enterprise oidc role mapping', 'role=admin')
}

async function verifyBrowserEnterpriseSamlSso(page, tenantId, providerState) {
  await page.clearSessionCookies()
  await page.navigate(SIGN_IN_PATH)
  await page.setPreferredLocale('en')
  await page.waitFor(
    () =>
      document.body.innerText.includes('Continue with SSO') &&
      Array.from(document.querySelectorAll('button')).some(
        (item) => String(item.textContent || '').trim() === 'Continue with SSO',
      ),
    15_000,
    'enterprise saml UI',
  )
  const ssoVisible = await page.evaluate(`(() => {
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
    return Array.from(document.querySelectorAll('form[aria-label="Sign in with SSO"]')).some(isVisible);
  })()`)
  if (ssoVisible !== true) await page.clickVisibleButton('SSO')
  await page.setVisibleInputValue('input[type="email"], input[autocomplete="email"]', samlEmail)
  await page.clickVisibleButton('Continue with SSO')
  try {
    await page.waitFor(
      () => location.pathname.startsWith('/console'),
      20_000,
      'enterprise saml console',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const samlState = providerState()
    const detail = {
      href: snapshot.href,
      text: snapshot.text.slice(0, 400),
      requestSeen: Boolean(samlState.lastRequest),
      relayState: samlState.lastRelayState,
      acsUrl: samlState.lastAcsUrl,
      network: page.authNetworkLog(),
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(detail)}`,
    )
  }
  try {
    await page.waitFor(
      () => document.body.innerText.includes('Sign out'),
      15_000,
      'enterprise saml signed in',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const me = await page.browserMe()
    const cookies = await page.sessionCookieSummary()
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify({
        href: snapshot.href,
        text: snapshot.text.slice(0, 400),
        meStatus: me.status,
        meBody: me.body.slice(0, 400),
        cookies,
        network: page.authNetworkLog(),
      })}`,
    )
  }

  const samlState = providerState()
  if (!samlState.lastRequest?.includes('<samlp:AuthnRequest')) {
    throw new Error('local SAML IdP did not receive AuthnRequest')
  }
  if (samlState.lastRelayState !== '/console') {
    throw new Error(`local SAML IdP RelayState mismatch: ${String(samlState.lastRelayState)}`)
  }
  if (samlState.lastAcsUrl !== `${baseUrl}/sso/saml/${samlConnectionId}/acs`) {
    throw new Error(`local SAML IdP ACS mismatch: ${String(samlState.lastAcsUrl)}`)
  }

  const cookie = await page.sessionCookieHeader()
  const me = await page.browserMe()
  if (me.status !== 200)
    throw new Error(`/v1/me failed after browser enterprise saml http=${me.status}`)
  const meBody = parseJson(me.body, '/v1/me')
  if (meBody.user?.email !== samlEmail) throw new Error(`/v1/me saml email mismatch: ${me.body}`)
  if (!meBody.activeOrg?.id || meBody.activeOrg.id !== tenantId) {
    throw new Error(`/v1/me saml activeOrg mismatch: ${me.body}`)
  }

  const identities = await d1(
    `SELECT COUNT(*) AS count FROM user_identities WHERE tenant_id = ${sqlString(tenantId)} AND identity_type = 'saml' AND provider = ${sqlString(samlConnectionId)} AND provider_user_id = ${sqlString(samlEmail)} AND revoked_at IS NULL;`,
    'verify local enterprise saml identity',
  )
  if (Number(identities[0]?.count ?? 0) !== 1) {
    throw new Error('local enterprise saml identity not created')
  }
  const memberships = await d1(
    `SELECT memberships.role AS role FROM memberships JOIN users ON users.id = memberships.user_id JOIN user_emails ON user_emails.user_id = users.id WHERE memberships.tenant_id = ${sqlString(tenantId)} AND memberships.org_id = ${sqlString(tenantId)} AND memberships.status = 'active' AND user_emails.email = ${sqlString(samlEmail)} LIMIT 1;`,
    'verify local enterprise saml membership',
  )
  if (memberships[0]?.role !== 'admin') {
    throw new Error(`local enterprise saml role mapping mismatch: ${String(memberships[0]?.role)}`)
  }

  const snapshot = await page.snapshot()
  if (!snapshot.pathname.startsWith('/console')) {
    throw new Error(`enterprise saml default target mismatch: ${snapshot.href}`)
  }
  assertNoConsoleDeadState(snapshot, 'enterprise saml console')
  if (snapshot.text.includes('Sign in')) {
    throw new Error('enterprise saml console shows Sign in after login')
  }
  if (snapshot.hasPlaceholderHref) throw new Error('enterprise saml console has placeholder href')
  if (snapshot.badClass || snapshot.htmlHasFunctionClass) {
    throw new Error('enterprise saml console has function class')
  }
  assertNoConsoleErrors(page, 'browser enterprise saml sign-in')
  printResult('PASS', 'browser enterprise saml default console', `connection=${samlConnectionId}`)
  printResult('PASS', 'browser enterprise saml cookie', cookie.split('; ')[0].split('=')[0])
  printResult(
    'PASS',
    'browser enterprise saml me active organization',
    `org=${meBody.activeOrg.id}`,
  )
  printResult('PASS', 'browser enterprise saml signed response', 'xml_dsig=true relay_state=true')
  printResult('PASS', 'browser enterprise saml role mapping', 'role=admin')
}

export async function runL3PasswordBrowserSmoke() {
  let fixture
  let localOidcProvider
  let localSamlProvider
  try {
    const health = await fetchText('/v1/health')
    if (health.res.status !== 200) {
      throw new Error(`dev server not healthy http=${health.res.status} body=${health.text}`)
    }
    printResult('PASS', 'dev server health', `http=${health.res.status}`)
    await ensureSeeded()
    fixture = await prepareLocalPassword()
    await verifyPasswordAuthConfig()
    localOidcProvider = await startLocalOidcProvider(fixture.pepper)
    await prepareLocalSocialProvider(fixture, localOidcProvider.issuer)
    await prepareLocalEnterpriseSso(fixture, localOidcProvider.issuer)
    localSamlProvider = await startLocalSamlProvider()
    await withChrome(async (page) => {
      const orgId = await verifyBrowserPasswordSignIn(page)
      await verifyBrowserConsoleProviderControls(page, orgId, fixture)
      await verifyBrowserMfaSelfService(page, fixture)
      await verifyBrowserSocialSignIn(page, fixture.tenantId, localOidcProvider.state)
      await verifyBrowserEnterpriseOidcSso(page, fixture.tenantId, localOidcProvider.state)
      await cleanupLocalEnterpriseSso(fixture.tenantId)
      await prepareLocalEnterpriseSamlSso(fixture, localSamlProvider.ssoUrl)
      await verifyBrowserEnterpriseSamlSso(page, fixture.tenantId, localSamlProvider.state)
    })
    await localOidcProvider.stop()
    localOidcProvider = null
    await localSamlProvider.stop()
    localSamlProvider = null
    await restoreMetadata(fixture)
  } catch (error) {
    if (localOidcProvider) {
      await localOidcProvider.stop().catch(() => undefined)
    }
    if (localSamlProvider) {
      await localSamlProvider.stop().catch(() => undefined)
    }
    try {
      await restoreMetadata(fixture)
    } catch (restoreError) {
      printResult('FAIL', 'restore local hosted auth policy', restoreError.message)
    }
    throw error
  }
}
