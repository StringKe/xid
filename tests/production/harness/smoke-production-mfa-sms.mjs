#!/usr/bin/env node

import {
  d1,
  fetchText,
  identifierHash,
  parseJson,
  printResult,
  readFileInputValue,
  registerCleanupSignalHandlers,
  requireFileInputValue,
  runCleanupSteps,
  sqlString,
  waitForLatestNotificationSent,
} from './production-auth.mjs'
import {
  beginProductionEvidence,
  EVIDENCE_KEYS,
  EVIDENCE_MARKERS,
  recordProductionEvidence,
} from './production-evidence.mjs'

async function loadVerifiedPhone(tenantId, userId) {
  const rows = await d1(
    `
SELECT id, phone
FROM user_phones
WHERE tenant_id = ${sqlString(tenantId)}
  AND user_id = ${sqlString(userId)}
  AND verified = 1
ORDER BY created_at DESC
LIMIT 1;
`,
    'load mfa sms verified phone',
  )
  const row = rows[0]
  if (!row?.phone) throw new Error('mfa sms user has no verified phone')
  return row
}

async function loadLatestSmsOtp(afterMs, tenantId, userId) {
  const rows = await d1(
    `
SELECT id, code_hash, consumed_at, expires_at
FROM verification_tokens
WHERE tenant_id = ${sqlString(tenantId)}
  AND user_id = ${sqlString(userId)}
  AND purpose = 'otp'
  AND channel = 'sms'
  AND created_at >= ${afterMs}
ORDER BY created_at DESC
LIMIT 1;
`,
    'load mfa sms otp',
  )
  const row = rows[0]
  if (!row) throw new Error('mfa sms otp token was not written to production D1')
  if (!row.code_hash) throw new Error('mfa sms otp has no code_hash')
  if (row.consumed_at !== null) throw new Error('mfa sms otp consumed before verify')
  if (Number(row.expires_at) <= Date.now()) throw new Error('mfa sms otp already expired')
  return row
}

async function verifySmsOtpConsumed(tokenId) {
  const rows = await d1(
    `
SELECT id, consumed_at
FROM verification_tokens
WHERE id = ${sqlString(tokenId)}
LIMIT 1;
`,
    'verify mfa sms otp consumed',
  )
  if (rows.length !== 0) throw new Error('mfa sms otp token still exists after verify')
  printResult('PASS', 'mfa sms one time consume', 'deleted=true')
}

// SKIP/verify 失败腿会留下 sms OTP;按 verification_tokens.id 主键删,爆炸半径恒为 1 行。
async function deleteMfaSmsOtp(tokenId) {
  if (!tokenId) return
  await d1(
    `DELETE FROM verification_tokens WHERE id = ${sqlString(tokenId)};`,
    'cleanup production mfa sms otp',
  )
  const rows = await d1(
    `SELECT COUNT(*) AS count FROM verification_tokens WHERE id = ${sqlString(tokenId)};`,
    'verify production mfa sms otp cleanup',
  )
  if (Number(rows[0]?.count ?? 0) !== 0) {
    throw new Error(`mfa sms otp ${tokenId} still exists after cleanup`)
  }
  printResult('PASS', 'production mfa sms otp cleanup', `token=${tokenId}`)
}

async function runSend(cookie, tenantId, userId, phone) {
  const before = Date.now()
  const { res, text } = await fetchText('/auth/mfa/sms/send', {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json' },
  })
  if (res.status !== 200) throw new Error(`mfa sms send failed http=${res.status} body=${text}`)
  const body = parseJson(text, 'mfa sms send')
  if (body?.ok !== true) throw new Error(`mfa sms send response mismatch: ${text}`)
  const token = await loadLatestSmsOtp(before, tenantId, userId)
  await waitForLatestNotificationSent({
    tenantId,
    type: 'otp',
    channel: 'sms',
    target: phone,
    afterMs: before,
  })
  printResult('PASS', 'mfa sms challenge send', `phone_hash=${await identifierHash(phone)}`)
  return token
}

async function runVerify(cookie, code, tokenId) {
  const { res, text } = await fetchText('/auth/mfa/verify', {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'sms', code, stepUp: true }),
  })
  if (res.status !== 200) throw new Error(`mfa sms verify failed http=${res.status} body=${text}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  if (!setCookie.includes('__Host-xid.acr='))
    throw new Error('mfa sms verify did not set acr cookie')
  await verifySmsOtpConsumed(tokenId)
  const replay = await fetchText('/auth/mfa/verify', {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'sms', code, stepUp: true }),
  })
  if (replay.res.status !== 400)
    throw new Error(`mfa sms replay expected 400 got ${replay.res.status}`)
  const replayCookie = replay.res.headers.get('set-cookie') ?? ''
  if (replayCookie.includes('__Host-xid.acr=')) throw new Error('mfa sms replay wrote acr cookie')
  printResult('PASS', 'mfa sms verify', `http=${res.status}`)
}

export async function runProductionMfaSmsSmoke() {
  const preSmokeContext = await beginProductionEvidence()
  const cookie = await requireFileInputValue('XID_PRODUCTION_MFA_SMS_COOKIE')
  const { res, text } = await fetchText('/v1/me', { cookie })
  if (res.status !== 200) throw new Error(`/v1/me failed before mfa sms http=${res.status}`)
  const me = parseJson(text, '/v1/me mfa sms')
  if (!me?.user?.id) throw new Error('/v1/me user id missing before mfa sms')
  if (!me?.activeOrg?.id) throw new Error('/v1/me activeOrg missing before mfa sms')
  const factorsRes = await fetchText('/v1/me/mfa-factors', { cookie })
  if (factorsRes.res.status !== 200) {
    throw new Error(`/v1/me/mfa-factors failed http=${factorsRes.res.status}`)
  }
  const factors = parseJson(factorsRes.text, '/v1/me/mfa-factors')
  if (!Array.isArray(factors) || !factors.some((factor) => factor?.type === 'sms')) {
    throw new Error('mfa sms factor is not provider-ready for this session')
  }
  const phone = await loadVerifiedPhone(me.activeOrg.id, me.user.id)

  // cookie 由操作者注入,绝不能 sign-out;本 harness 仅清理自己写的 OTP 行。
  let tokenId = null
  let primaryError = null
  const unregisterSignals = registerCleanupSignalHandlers(() => deleteMfaSmsOtp(tokenId))
  try {
    const token = await runSend(cookie, me.activeOrg.id, me.user.id, phone.phone)
    tokenId = String(token.id)
    const code = await readFileInputValue('XID_PRODUCTION_MFA_SMS_CODE')
    if (!code) {
      printResult(
        'SKIP',
        'mfa sms verify',
        'set XID_PRODUCTION_MFA_SMS_CODE_FILE to the real received code file',
      )
      return
    }
    if (!/^\d{6}$/.test(code))
      throw new Error('XID_PRODUCTION_MFA_SMS_CODE_FILE must contain 6 digits')
    await runVerify(cookie, code, tokenId)
    const after = await fetchText('/v1/me', { cookie })
    if (after.res.status !== 200)
      throw new Error(`/v1/me failed after mfa sms http=${after.res.status}`)
    printResult('PASS', 'mfa sms active session', `org=${me.activeOrg.id}`)
    await recordProductionEvidence(
      EVIDENCE_KEYS.mfaSmsFull,
      EVIDENCE_MARKERS.mfaSmsFull,
      preSmokeContext,
    )
    printResult('PASS', 'production evidence recorded', EVIDENCE_KEYS.mfaSmsFull)
  } catch (error) {
    primaryError = error
  } finally {
    unregisterSignals()
    const { failures } = await runCleanupSteps([
      { name: 'mfa sms otp row', run: () => deleteMfaSmsOtp(tokenId) },
    ])
    // finally 内 throw:SKIP 腿提前 return 会跳过尾部 throw;有 primaryError 时不盖错。
    if (failures.length > 0 && !primaryError) {
      throw new Error(
        `mfa sms cleanup failed: ${failures.map((failure) => failure.name).join(', ')}`,
      )
    }
  }
  if (primaryError) throw primaryError
}
