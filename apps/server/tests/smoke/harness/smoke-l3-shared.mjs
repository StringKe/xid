#!/usr/bin/env node

import { argon2id } from '@noble/hashes/argon2'
import { spawn } from 'node:child_process'
import { parseD1Json } from './d1-json.mjs'

export const DEFAULT_BASE_URL = 'http://localhost:5173'
export const DEFAULT_PASSWORD = 'LocalL3Protocol123!'
export const PACKAGE_MANAGER = process.env.XID_L3_PACKAGE_MANAGER ?? 'corepack'
export const PACKAGE_MANAGER_ARGS = ['pnpm']
export const baseUrl = (process.env.XID_L3_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
export const adminEmail = (process.env.XID_L3_ADMIN_EMAIL ?? 'admin@localhost').toLowerCase()
export const adminPassword = process.env.XID_L3_ADMIN_PASSWORD ?? DEFAULT_PASSWORD
export const smokePersistPath = process.env.XID_SMOKE_PERSIST_PATH

if (smokePersistPath === undefined || smokePersistPath.length === 0) {
  throw new Error('XID_SMOKE_PERSIST_PATH missing')
}

const ARGON2_MEMORY_KB = 65536
const ARGON2_ITERATIONS = 3
const ARGON2_HASH_LEN = 32
const ARGON2_PARALLELISM = 1

export function printResult(status, name, detail) {
  process.stdout.write(`${status} ${name}${detail ? ` ${detail}` : ''}\n`)
}

export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

export function sqlJson(value) {
  return sqlString(JSON.stringify(value))
}

export function collectSetCookie(res) {
  const cookies = []
  if (typeof res.headers.getSetCookie === 'function') cookies.push(...res.headers.getSetCookie())
  const single = res.headers.get('set-cookie')
  if (single) cookies.push(single)
  return cookies.map((value) => value.split(';')[0]).join('; ')
}

export async function fetchText(path, options = {}) {
  const headers = new Headers(options.headers)
  if (options.cookie) headers.set('cookie', options.cookie)
  const res = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' })
  const text = await res.text()
  return { res, text }
}

export function parseDevVars() {
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

export async function applyLocalMigrations() {
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

export async function d1(command, name) {
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

function decodePepper(raw) {
  const match = raw.match(/^v\d+:(.+)$/)
  const value = match ? match[1] : raw
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

function applyPepper(password, pepper) {
  const encoded = new TextEncoder().encode(password)
  const out = new Uint8Array(pepper.length + encoded.length)
  out.set(pepper, 0)
  out.set(encoded, pepper.length)
  return out
}

function encodeArgon2Hash(digest, salt) {
  return `$argon2id$v=19$m=${ARGON2_MEMORY_KB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}$${Buffer.from(salt).toString('base64url')}$${Buffer.from(digest).toString('base64url')}`
}

export async function hashPassword(password, pepperRaw) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const digest = argon2id(applyPepper(password, decodePepper(pepperRaw)), salt, {
    m: ARGON2_MEMORY_KB,
    t: ARGON2_ITERATIONS,
    p: ARGON2_PARALLELISM,
    dkLen: ARGON2_HASH_LEN,
    version: 0x13,
  })
  return { hash: encodeArgon2Hash(digest, salt), algo: 'argon2id', pepperVersion: 1 }
}

export async function passwordReuseTag(password, pepperRaw) {
  const key = await crypto.subtle.importKey(
    'raw',
    decodePepper(pepperRaw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const normalized = password.length > 128 ? password.slice(0, 128) : password
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalized))
  return `pwd-reuse:v1:${Buffer.from(new Uint8Array(signature)).toString('base64')}`
}

export async function ensureSeeded() {
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

export async function loadAdminFixture() {
  const rows = await d1(
    `SELECT users.id AS user_id, users.tenant_id AS tenant_id FROM users JOIN user_emails ON user_emails.user_id = users.id WHERE user_emails.email = ${sqlString(adminEmail)} LIMIT 1;`,
    'load admin user',
  )
  const row = rows[0]
  if (!row) throw new Error(`admin user not found: ${adminEmail}`)
  return { tenantId: row.tenant_id, userId: row.user_id }
}

export async function login() {
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
  printResult('PASS', 'password sign-in', `http=${res.res.status}`)
  return cookie
}

export async function ensureDevServerHealthy() {
  const health = await fetchText('/v1/health')
  if (health.res.status !== 200) {
    throw new Error(`dev server not healthy http=${health.res.status} body=${health.text}`)
  }
  printResult('PASS', 'dev server health', `http=${health.res.status}`)
}
