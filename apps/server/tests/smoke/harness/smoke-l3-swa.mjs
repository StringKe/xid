#!/usr/bin/env node

import { baseUrl, d1, fetchText, printResult, sqlString } from './smoke-l3-shared.mjs'

export const swaUsernameField = 'login_id'
export const swaPasswordField = 'passcode'
export const swaTargetUrl = `${baseUrl}/test-harness/fake-swa/login`

const swaCredential = { username: 'swauser', password: 'SwaDownstream42' }

function readFormAction(html) {
  return /<form method="post" action="([^"]+)">/.exec(html)?.[1] ?? null
}

function readHiddenInputs(html) {
  const fields = new Map()
  for (const match of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
    fields.set(match[1], match[2])
  }
  return fields
}

function assertLaunchHeaders(res) {
  const cacheControl = res.headers.get('cache-control') ?? ''
  if (!cacheControl.includes('no-store')) {
    throw new Error(`SWA launch cache-control=${cacheControl}`)
  }
  const csp = res.headers.get('content-security-policy') ?? ''
  const targetOrigin = new URL(swaTargetUrl).origin
  if (!csp.includes(`form-action ${targetOrigin}`) || !csp.includes("default-src 'none'")) {
    throw new Error(`SWA launch CSP=${csp}`)
  }
}

function assertLaunchForm(html) {
  const action = readFormAction(html)
  if (action !== swaTargetUrl) throw new Error(`SWA launch form action=${action}`)
  const fields = readHiddenInputs(html)
  const names = [...fields.keys()].sort()
  const expected = [swaPasswordField, swaUsernameField].sort()
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`SWA launch fields=${JSON.stringify(names)}`)
  }
  if (
    fields.get(swaUsernameField) !== swaCredential.username ||
    fields.get(swaPasswordField) !== swaCredential.password
  ) {
    throw new Error('SWA launch form does not carry the vaulted credential')
  }
  return { action, fields }
}

// 已登录成员保存下游凭据 -> launch 返回自动提交表单 -> 表单提交到假下游应用并登录成功。
export async function runSwaVaultLaunchFlow(connectionId, cookie) {
  const vault = await fetchText(`/sso/swa/${connectionId}/vault`, {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(swaCredential),
  })
  if (vault.res.status !== 200) {
    throw new Error(`SWA vault save failed http=${vault.res.status} body=${vault.text}`)
  }
  printResult('PASS', 'legacy SWA vault save', `http=${vault.res.status}`)

  const launch = await fetchText(`/sso/swa/${connectionId}/launch`, { cookie })
  if (launch.res.status !== 200) {
    throw new Error(`SWA launch failed http=${launch.res.status} body=${launch.text}`)
  }
  assertLaunchHeaders(launch.res)
  const { action, fields } = assertLaunchForm(launch.text)
  printResult('PASS', 'legacy SWA launch form', `action=${action}`)

  const downstream = await fetch(action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([...fields.entries()]),
    redirect: 'manual',
  })
  const downstreamBody = await downstream.text()
  if (downstream.status !== 200 || JSON.parse(downstreamBody).signedIn !== true) {
    throw new Error(`fake SWA downstream rejected http=${downstream.status} body=${downstreamBody}`)
  }
  printResult('PASS', 'legacy SWA downstream sign-in', `http=${downstream.status}`)
}

export async function cleanupSwaCredentials(tenantId, connectionId) {
  await d1(
    `DELETE FROM swa_credentials WHERE tenant_id = ${sqlString(tenantId)} AND connection_id = ${sqlString(connectionId)};`,
    'cleanup SWA credentials',
  )
}
