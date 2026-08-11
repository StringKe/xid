#!/usr/bin/env node

import {
  assertNoNotificationFailure,
  assertNoSmokeResidue,
  d1,
  fetchText,
  identifierHash,
  parseJson,
  printResult,
  readFileInputValue,
  redactKnownText,
  registerCleanupSignalHandlers,
  runCleanupSteps,
  SMOKE_ID_PREFIXES,
  smokeSweepTables,
  sqlString,
  sweepSmokeResidue,
  verifyTokenConsumed,
  waitForLatestNotificationSent,
} from './production-auth.mjs'
import {
  beginProductionEvidence,
  EVIDENCE_KEYS,
  EVIDENCE_MARKERS,
  recordProductionEvidence,
} from './production-evidence.mjs'

const channel = (process.env['XID_PRODUCTION_PHONE_OTP_CHANNEL'] ?? 'whatsapp').trim()
const sendOnly = process.env['XID_PRODUCTION_PHONE_OTP_SEND_ONLY'] === '1'
const providedOrganizationId = process.env['XID_PRODUCTION_PHONE_OTP_ORGANIZATION_ID']?.trim()

if (channel !== 'whatsapp' && channel !== 'sms') {
  throw new Error('XID_PRODUCTION_PHONE_OTP_CHANNEL must be whatsapp or sms')
}

// DELETE 仅以 organizationId 锚定,且可由环境变量指定;前缀白名单在读/写入口各校验一次。
function assertSmokeOrganizationId(organizationId) {
  const prefix = SMOKE_ID_PREFIXES.organization
  if (typeof organizationId !== 'string' || !organizationId.startsWith(prefix)) {
    throw new Error(
      `refusing to touch organization ${String(organizationId)}: phone otp smoke only seeds and deletes ${prefix}* organizations`,
    )
  }
  return organizationId
}

if (providedOrganizationId) assertSmokeOrganizationId(providedOrganizationId)

function methodName() {
  return channel === 'whatsapp' ? 'whatsappOtp' : 'smsOtp'
}

function sendPath() {
  return channel === 'whatsapp' ? '/auth/otp/whatsapp/send' : '/auth/otp/sms/send'
}

function verifyPath() {
  return channel === 'whatsapp' ? '/auth/otp/whatsapp/verify' : '/auth/otp/sms/verify'
}

function phoneSmokeHostedAuthPolicy() {
  const enabled = { enabled: true, allowLogin: true, allowUserCreation: true }
  const disabled = { enabled: false, allowLogin: false, allowUserCreation: false }
  return {
    identifierMode: 'phone',
    requireVerifiedEmail: false,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
    forceSso: false,
    allowUserCreation: true,
    allowExistingUserLogin: true,
    profileFields: {
      email: 'hidden',
      username: 'hidden',
      phone: 'required',
      name: 'hidden',
      givenName: 'hidden',
      familyName: 'hidden',
    },
    password: disabled,
    magicLink: disabled,
    emailOtp: disabled,
    whatsappOtp: channel === 'whatsapp' ? enabled : disabled,
    smsOtp: channel === 'sms' ? enabled : disabled,
    passkey: disabled,
    enterpriseSso: {
      enabled: false,
      allowLogin: false,
      allowJitUserCreation: false,
      domainDiscovery: false,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    },
  }
}

// notification_delivery_outbox 不在共享扫除清单,按本 harness 写入面补;audit_events 故意不清。
const EXTRA_TENANT_TABLES = Object.freeze(['notification_delivery_outbox'])

// 清理表清单复用共享扫除清单,避免本地第二份漂移漏表。
function phoneOtpCleanupTables() {
  return [...smokeSweepTables().map((entry) => entry.table), ...EXTRA_TENANT_TABLES]
}

// org 行 tenant_id 通常等于 id;多带 id 条件兼容手工 org 未把 tenant_id 指到自身的情况。
function tenantScopedWhere(table, scope) {
  return table === 'organizations'
    ? `tenant_id = ${scope} OR id = ${scope}`
    : `tenant_id = ${scope}`
}

async function assertPhoneOtpOrganizationGone(organizationId, tables) {
  const scope = sqlString(organizationId)
  const columns = tables.map(
    (table) =>
      `  (SELECT COUNT(*) FROM ${table} WHERE ${tenantScopedWhere(table, scope)}) AS ${table}`,
  )
  const rows = await d1(
    `SELECT\n${columns.join(',\n')};\n`,
    'verify production phone otp smoke cleanup',
  )
  const row = rows[0] ?? {}
  const left = tables
    .map((table) => [table, Number(row[table] ?? 0)])
    .filter(([, count]) => count > 0)
  if (left.length > 0) {
    const detail = left.map(([table, count]) => `${table}=${count}`).join(' ')
    throw new Error(`phone otp cleanup left production rows for ${organizationId}: ${detail}`)
  }
}

async function cleanupPhoneOtpSmokeOrganization(organizationId) {
  if (!organizationId) return
  assertSmokeOrganizationId(organizationId)
  const tables = phoneOtpCleanupTables()
  const scope = sqlString(organizationId)
  const statements = tables.map(
    (table) => `DELETE FROM ${table} WHERE ${tenantScopedWhere(table, scope)};`,
  )
  await d1(`${statements.join('\n')}\n`, 'cleanup production phone otp smoke organization')
  await assertPhoneOtpOrganizationGone(organizationId, tables)
  printResult(
    'PASS',
    'production phone otp cleanup',
    `channel=${channel} org=${organizationId} tables=${tables.length}`,
  )
}

async function seedPhoneOtpSmokeOrganization() {
  const now = Date.now()
  const instanceRows = await d1(
    `
SELECT id
FROM instances
WHERE status = 'active'
ORDER BY created_at ASC
LIMIT 1;
`,
    'load production instance for phone otp smoke',
  )
  const instanceId = instanceRows[0]?.id
  if (!instanceId) throw new Error('production instance missing')
  const organizationId = `org_smoke_${channel}_otp_${crypto.randomUUID()}`
  const slug = `smoke-${channel}-otp-${Date.now()}`
  const privateMetadata = JSON.stringify({ hostedAuth: phoneSmokeHostedAuthPolicy() })
  await d1(
    `
INSERT INTO organizations
  (id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata, private_metadata, seat_used, enrollment_mode, allow_org_self_service, status, deleted_at, created_at, updated_at)
VALUES
  (${sqlString(organizationId)}, ${sqlString(organizationId)}, ${sqlString(instanceId)}, NULL, ${sqlString(slug)}, ${sqlString(`Production ${channel} OTP Smoke Organization`)}, '{}', ${sqlString(privateMetadata)}, 0, 'invite_required', 1, 'active', NULL, ${now}, ${now});
`,
    'seed production phone otp smoke organization',
  )
  printResult(
    'PASS',
    'production phone otp organization seed',
    `channel=${channel} org=${organizationId}`,
  )
  return organizationId
}

async function checkPhoneOtpAuthConfig(organizationId) {
  const { res, text } = await fetchText(
    `/auth/config?organization_id=${encodeURIComponent(organizationId)}`,
  )
  if (res.status !== 200) {
    throw new Error(`phone otp auth config failed http=${res.status} body=${text}`)
  }
  const body = parseJson(text, 'phone otp auth config')
  const method = body?.methods?.[methodName()]
  if (
    method?.enabled !== true ||
    method?.allowLogin !== true ||
    method?.allowUserCreation !== true
  ) {
    printResult(
      'SKIP',
      'production phone otp provider not ready',
      `channel=${channel} org=${organizationId}`,
    )
    return false
  }
  const otherMethod = channel === 'whatsapp' ? body?.methods?.smsOtp : body?.methods?.whatsappOtp
  if (otherMethod?.enabled === true) {
    throw new Error(`phone otp auth config exposed the other channel: ${text}`)
  }
  if (
    body?.methods?.magicLink?.enabled ||
    body?.methods?.emailOtp?.enabled ||
    body?.methods?.password?.enabled ||
    body?.methods?.passkey?.enabled ||
    body?.methods?.enterpriseSso?.enabled
  ) {
    throw new Error(`phone otp auth config exposed unrelated methods: ${text}`)
  }
  printResult(
    'PASS',
    'production phone otp auth config',
    `channel=${channel} org=${organizationId}`,
  )
  return true
}

async function requirePhone() {
  const phone = await readFileInputValue('XID_PRODUCTION_PHONE_OTP_PHONE')
  if (!phone) {
    throw new Error('set XID_PRODUCTION_PHONE_OTP_PHONE_FILE to a real E.164 phone number file')
  }
  return phone
}

async function requireCode() {
  const code = await readFileInputValue('XID_PRODUCTION_PHONE_OTP_CODE')
  if (!code || !/^\d{6}$/.test(code)) {
    throw new Error(
      'set XID_PRODUCTION_PHONE_OTP_CODE_FILE to the real 6 digit code file received on the phone',
    )
  }
  return code
}

async function loadLatestPhoneOtp(afterMs, organizationId, targetPhone) {
  const rows = await d1(
    `
SELECT
  vt.id,
  vt.tenant_id AS tenant_id,
  vt.user_id AS user_id,
  vt.code_hash AS code_hash,
  vt.consumed_at AS consumed_at,
  vt.expires_at AS expires_at,
  vt.created_at AS created_at
FROM verification_tokens vt
JOIN user_phones up ON up.user_id = vt.user_id
WHERE vt.tenant_id = ${sqlString(organizationId)}
  AND up.phone = ${sqlString(targetPhone)}
  AND vt.purpose = 'otp'
  AND vt.channel = ${sqlString(channel)}
  AND vt.created_at >= ${afterMs}
ORDER BY vt.created_at DESC
LIMIT 1;
`,
    'load latest phone otp',
  )
  const row = rows[0]
  if (!row) throw new Error('phone otp token was not written to production D1')
  if (!row.code_hash) throw new Error('phone otp token has no code_hash')
  if (row.consumed_at !== null) throw new Error('phone otp token consumed before smoke')
  if (Number(row.expires_at) <= Date.now()) throw new Error('phone otp token already expired')
  printResult(
    'PASS',
    'phone otp d1 token',
    `channel=${channel} user=${row.user_id} phone_hash=${await identifierHash(targetPhone)}`,
  )
  return row
}

async function waitForLatestPhoneOtp(afterMs, organizationId, targetPhone, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await loadLatestPhoneOtp(afterMs, organizationId, targetPhone)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => {
        setTimeout(resolve, 1500)
      })
    }
  }
  throw lastError ?? new Error('phone otp token was not written to production D1')
}

async function sendPhoneOtp(organizationId, targetPhone) {
  const afterMs = Date.now()
  const { res, text } = await fetchText(sendPath(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      phone: targetPhone,
      organizationId,
      turnstileToken: null,
    }),
  })
  if (res.status !== 200) {
    throw new Error(
      `phone otp send failed http=${res.status} body=${redactKnownText(text, [targetPhone])}`,
    )
  }
  const body = parseJson(text, 'phone otp send')
  if (body?.ok !== true) throw new Error(`phone otp send response mismatch: ${text}`)
  printResult(
    'PASS',
    'phone otp send',
    `channel=${channel} http=${res.status} phone_hash=${await identifierHash(targetPhone)}`,
  )
  const row = await waitForLatestPhoneOtp(afterMs, organizationId, targetPhone)
  await waitForLatestNotificationSent({
    tenantId: organizationId,
    type: 'otp',
    channel,
    target: targetPhone,
    afterMs,
  })
  await assertNoNotificationFailure({
    tenantId: organizationId,
    type: 'otp',
    channel,
    target: targetPhone,
    afterMs,
  })
  return row
}

async function verifyPhoneOtp(organizationId, targetPhone, code) {
  const row = await loadLatestPhoneOtp(0, organizationId, targetPhone)
  const { res, text } = await fetchText(verifyPath(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      phone: targetPhone,
      code,
      organizationId,
    }),
  })
  if (res.status !== 200) {
    throw new Error(
      `phone otp verify failed http=${res.status} body=${redactKnownText(text, [targetPhone, code])}`,
    )
  }
  const cookie = res.headers.get('set-cookie') ?? ''
  if (!cookie.includes('__Host-xid.rt.'))
    throw new Error('phone otp verify did not set session cookie')
  const me = await fetchText('/v1/me', { cookie })
  if (me.res.status !== 200) {
    throw new Error(`/v1/me failed after phone otp http=${me.res.status}`)
  }
  const body = parseJson(me.text, '/v1/me')
  if (body?.user?.instanceManager !== false) {
    throw new Error(`/v1/me instanceManager mismatch: ${redactKnownText(me.text, [targetPhone])}`)
  }
  if (body?.activeOrg?.id !== organizationId) {
    throw new Error(`/v1/me activeOrg mismatch: ${redactKnownText(me.text, [targetPhone])}`)
  }
  if (!Array.isArray(body?.organizations) || body.organizations.length !== 1) {
    throw new Error(`/v1/me organizations mismatch: ${redactKnownText(me.text, [targetPhone])}`)
  }
  await verifyTokenConsumed(String(row.id))
  const replay = await fetchText(verifyPath(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: targetPhone, code, organizationId }),
  })
  if (replay.res.status !== 400) {
    throw new Error(`phone otp replay expected 400 got http=${replay.res.status}`)
  }
  const replayCookie = replay.res.headers.get('set-cookie') ?? ''
  if (replayCookie.includes('__Host-xid.rt.')) {
    throw new Error('phone otp replay wrote session cookie')
  }
  printResult('PASS', 'phone otp verify cookie', `channel=${channel} http=${res.status}`)
  printResult(
    'PASS',
    'phone otp me active organization',
    `channel=${channel} org=${organizationId}`,
  )
  printResult('PASS', 'phone otp replay invalid', `channel=${channel} http=${replay.res.status}`)
}

export async function runProductionPhoneOtpSmoke() {
  const preSmokeContext = await beginProductionEvidence()
  let organizationId = providedOrganizationId || null
  let primaryError = null
  let keepOrganization = Boolean(providedOrganizationId)
  // 信号杀进程时 finally 不跑,seed 出的 org/用户会留在生产库。
  const unregisterSignals = registerCleanupSignalHandlers(async () => {
    if (keepOrganization) return
    await cleanupPhoneOtpSmokeOrganization(organizationId)
  })
  try {
    if (!organizationId) {
      // 只在 fresh 腿扫上一轮残留;resume 腿绝不能扫,会删掉正要用的 org。
      await sweepSmokeResidue()
      organizationId = await seedPhoneOtpSmokeOrganization()
      keepOrganization = false
    }
    const ready = await checkPhoneOtpAuthConfig(organizationId)
    if (!ready) return

    if (providedOrganizationId) {
      const targetPhone = await requirePhone()
      const code = await requireCode()
      await verifyPhoneOtp(organizationId, targetPhone, code)
      await recordProductionEvidence(
        channel === 'whatsapp' ? EVIDENCE_KEYS.phoneOtpWhatsappFull : EVIDENCE_KEYS.phoneOtpSmsFull,
        EVIDENCE_MARKERS.phoneOtpFull,
        preSmokeContext,
      )
      printResult(
        'PASS',
        'production evidence recorded',
        channel === 'whatsapp' ? EVIDENCE_KEYS.phoneOtpWhatsappFull : EVIDENCE_KEYS.phoneOtpSmsFull,
      )
      keepOrganization = false
      return
    }

    const targetPhone = await requirePhone()
    await sendPhoneOtp(organizationId, targetPhone)
    if (sendOnly) {
      keepOrganization = true
      printResult(
        'SKIP',
        'phone otp verify',
        `send-only mode keeps org=${organizationId}; set XID_PRODUCTION_PHONE_OTP_ORGANIZATION_ID, XID_PRODUCTION_PHONE_OTP_PHONE_FILE and XID_PRODUCTION_PHONE_OTP_CODE_FILE after receiving the real code`,
      )
      return
    }
    keepOrganization = true
    throw new Error(
      `missing XID_PRODUCTION_PHONE_OTP_CODE_FILE; set XID_PRODUCTION_PHONE_OTP_ORGANIZATION_ID=${organizationId} with the real received code file and rerun full smoke`,
    )
  } catch (error) {
    primaryError = error
  } finally {
    unregisterSignals()
    if (keepOrganization) {
      // 两段式交接:org 必须活到操作者带 code 回来;无人收的由下一轮 fresh 扫除。
      printResult(
        'SKIP',
        'production phone otp cleanup',
        `handoff keeps org=${organizationId}; the next fresh run sweeps it if nobody returns`,
      )
    } else {
      const { failures } = await runCleanupSteps([
        {
          name: 'phone otp smoke organization',
          run: () => cleanupPhoneOtpSmokeOrganization(organizationId),
        },
        { name: 'phone otp smoke residue guard', run: () => assertNoSmokeResidue() },
      ])
      // finally 内 throw:清理失败判红(try 提前 return 会跳过尾部 throw);有 primaryError 时不盖错。
      if (failures.length > 0 && !primaryError) {
        throw new Error(
          `phone otp cleanup failed: ${failures.map((failure) => failure.name).join(', ')}`,
        )
      }
    }
  }
  if (primaryError) throw primaryError
}
