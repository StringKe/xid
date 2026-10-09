#!/usr/bin/env node

import {
  adminEmail,
  applyLocalMigrations,
  collectSetCookie,
  d1,
  ensureDevServerHealthy,
  ensureSeeded,
  fetchText,
  loadAdminFixture,
  printResult,
  sqlString,
} from './smoke-l3-shared.mjs'
import { pollUntil } from './poll-until.mjs'

const smsPhone = '+12125550142'
const whatsappPhone = '+12125550143'

const phoneRecipients = [
  { channel: 'sms', phone: smsPhone },
  { channel: 'whatsapp', phone: whatsappPhone },
]

async function enableTestDeliveryChannels(fixture) {
  const rows = await d1(
    `SELECT private_metadata FROM organizations WHERE id = ${sqlString(fixture.tenantId)} LIMIT 1;`,
    'load org metadata',
  )
  const metadata = JSON.parse(rows[0]?.private_metadata || '{}')
  metadata.deliveryChannels = {
    sms: { enabled: true, provider: 'test', from: 'XID' },
    whatsapp: { enabled: true, provider: 'test', from: 'XID' },
  }
  metadata.hostedAuth = {
    ...(metadata.hostedAuth ?? {}),
    identifierMode: 'phone',
    allowExistingUserLogin: true,
    smsOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
    whatsappOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
    mfa: { ...(metadata.hostedAuth?.mfa ?? {}), sms: { enabled: true } },
  }
  const now = Date.now()
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${now} WHERE id = ${sqlString(fixture.tenantId)};`,
    'enable test delivery channels',
  )
}

async function ensureTestPhoneRecipients(fixture) {
  const now = Date.now()
  for (const recipient of phoneRecipients) {
    const id = `smoke-${recipient.channel}-${fixture.userId}`
    await d1(
      `INSERT INTO user_phones (id, tenant_id, user_id, phone, verified, verification_status, is_primary, verified_at, created_at, updated_at) VALUES (${sqlString(id)}, ${sqlString(fixture.tenantId)}, ${sqlString(fixture.userId)}, ${sqlString(recipient.phone)}, 1, 'verified', 0, ${now}, ${now}, ${now}) ON CONFLICT(tenant_id, phone) DO UPDATE SET user_id = excluded.user_id, verified = excluded.verified, verification_status = excluded.verification_status, is_primary = excluded.is_primary, verified_at = excluded.verified_at, updated_at = excluded.updated_at;`,
      `ensure ${recipient.channel} test phone recipient`,
    )
  }
}

async function enableEmailOtpSignIn(fixture) {
  const rows = await d1(
    `SELECT private_metadata FROM organizations WHERE id = ${sqlString(fixture.tenantId)} LIMIT 1;`,
    'load org metadata',
  )
  const metadata = JSON.parse(rows[0]?.private_metadata || '{}')
  metadata.hostedAuth = {
    ...(metadata.hostedAuth ?? {}),
    identifierMode: 'email',
    emailOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
  }
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'enable email otp sign-in',
  )
}

async function signInWithEmailOtp() {
  const send = await fetchText('/auth/otp/email/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail }),
  })
  if (send.res.status !== 200 && send.res.status !== 202) {
    throw new Error(`email otp send failed http=${send.res.status} body=${send.text}`)
  }
  printResult('PASS', 'email otp enqueue', `http=${send.res.status}`)
  const record = await assertOtpCapture(adminEmail, 'email')
  const verify = await fetchText('/auth/otp/email/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, code: record.code }),
  })
  const cookie = collectSetCookie(verify.res)
  if (verify.res.status !== 200 || !cookie.includes('__Host-xid.rt.')) {
    throw new Error(`email otp sign-in failed http=${verify.res.status} body=${verify.text}`)
  }
  printResult('PASS', 'email otp sign-in', `http=${verify.res.status}`)
  return cookie
}

async function assertActiveUserMetering(fixture, cookie) {
  const stats = await pollUntil(
    async () => {
      const res = await fetchText(
        `/v1/organizations/${encodeURIComponent(fixture.tenantId)}/stats`,
        {
          cookie,
        },
      )
      if (res.res.status !== 200) {
        throw new Error(`organization stats failed http=${res.res.status} body=${res.text}`)
      }
      return JSON.parse(res.text)
    },
    {
      isReady: (value) => value.dau >= 1,
      label: `organization stats dau tenant=${fixture.tenantId}`,
    },
  )
  if (stats.mau < stats.dau) {
    throw new Error(`organization stats mau below dau: ${JSON.stringify(stats)}`)
  }
  printResult('PASS', 'metering dau/mau', `dau=${stats.dau} mau=${stats.mau}`)
}

async function assertOtpCapture(recipient, channel) {
  const record = await pollUntil(
    async () => {
      const latest = await fetchText(`/test/otp/latest?recipient=${encodeURIComponent(recipient)}`)
      if (latest.res.status === 404) return null
      if (latest.res.status !== 200) {
        throw new Error(
          `${channel} otp capture failed http=${latest.res.status} body=${latest.text}`,
        )
      }
      return JSON.parse(latest.text)
    },
    {
      isReady: (value) => value !== null,
      label: `otp capture channel=${channel} recipient=${recipient}`,
    },
  )
  if (!record.code || record.provider !== 'test' || record.channel !== channel) {
    throw new Error(`${channel} otp record invalid: ${JSON.stringify(record)}`)
  }
  printResult('PASS', `test ${channel} otp capture`, `code_len=${record.code.length}`)
  return record
}

export async function runL3DeliveryOtpSmoke() {
  await applyLocalMigrations()
  await ensureDevServerHealthy()
  await ensureSeeded()
  const fixture = await loadAdminFixture()
  await enableTestDeliveryChannels(fixture)
  await ensureTestPhoneRecipients(fixture)

  const smsSend = await fetchText('/auth/otp/sms/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: smsPhone }),
  })
  if (smsSend.res.status !== 200 && smsSend.res.status !== 202) {
    throw new Error(`sms otp send failed http=${smsSend.res.status} body=${smsSend.text}`)
  }
  printResult('PASS', 'sms otp enqueue', `http=${smsSend.res.status}`)
  await assertOtpCapture(smsPhone, 'sms')

  const whatsappSend = await fetchText('/auth/otp/whatsapp/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: whatsappPhone }),
  })
  if (whatsappSend.res.status !== 200 && whatsappSend.res.status !== 202) {
    throw new Error(
      `whatsapp otp send failed http=${whatsappSend.res.status} body=${whatsappSend.text}`,
    )
  }
  printResult('PASS', 'whatsapp otp enqueue', `http=${whatsappSend.res.status}`)
  await assertOtpCapture(whatsappPhone, 'whatsapp')

  await enableEmailOtpSignIn(fixture)
  const cookie = await signInWithEmailOtp()
  await assertActiveUserMetering(fixture, cookie)
}
