// SAML connection 解析 + SP EntityID/ACS URL 推导 + SP 解密私钥载入(EncryptedAssertion 用)。
// connection 按 id 查(租户隔离,自动注入 tenant_id);SP EntityID/ACS 从 TenantContext.issuer 派生(租户隔离,见 8.9)。
// SP 解密私钥存 CertStore 信封加密(iv/ciphertext/tag 三 blob),运行时 KEK 解密 -> 不可导出 importKey(见 signing-keys rule)。

import { envelopeDecrypt, toBufferSource } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { decodeKek } from '../oidc/shared'
import type { XidHonoEnv } from '../lib/types'
import { isLoopbackHttpUrl, isPublicHttpsUrl } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'

export type SamlConnection = typeof schema.ssoConnections.$inferSelect
type CertRow = typeof schema.certStore.$inferSelect

// 本 SP EntityID = issuer + /saml/{connection_id}(租户隔离,见 8.9)。
export function spEntityId(ctx: TenantContext, connectionId: string): string {
  return `${ctx.issuer}/saml/${connectionId}`
}

// 本 ACS URL = issuer + /sso/saml/{connection_id}/acs(Recipient/AssertionConsumerService Location)。
export function acsUrl(ctx: TenantContext, connectionId: string): string {
  return `${ctx.issuer}/sso/saml/${connectionId}/acs`
}

// 本 SLO URL = issuer + /sso/saml/{connection_id}/slo(SingleLogoutService Location)。
export function sloUrl(ctx: TenantContext, connectionId: string): string {
  return `${ctx.issuer}/sso/saml/${connectionId}/slo`
}

// 按 connection_id 查 SAML connection(租户隔离)。未找到 / 非 SAML / 非 active -> connection_not_found 404。
export async function resolveConnection(
  c: Context<XidHonoEnv>,
  connectionId: string,
): Promise<SamlConnection> {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const row = await db.ssoConnections.findOne(eq(schema.ssoConnections.id, connectionId))
  const permitsLoopbackHttp = isDevOrTestEnvironment(c.env)
  const endpointAllowed = (url: string): boolean =>
    isPublicHttpsUrl(url) || (permitsLoopbackHttp && isLoopbackHttpUrl(url))
  if (
    !row ||
    row.protocol !== 'saml' ||
    row.status !== 'active' ||
    !row.idpSsoUrl ||
    !endpointAllowed(row.idpSsoUrl) ||
    (row.idpSloUrl !== null && row.idpSloUrl !== undefined && !endpointAllowed(row.idpSloUrl)) ||
    (row.idpMetadataUrl !== null &&
      row.idpMetadataUrl !== undefined &&
      !endpointAllowed(row.idpMetadataUrl))
  ) {
    throw new AppError('connection_not_found', { httpStatus: 404 })
  }
  return row
}

// 取 connection 的 SP 解密私钥行(CertStore,usage=saml_sp_encryption,active)。无 spCertId 返回 null。
async function findSpDecryptCert(
  c: Context<XidHonoEnv>,
  connection: SamlConnection,
): Promise<CertRow | null> {
  if (!connection.spCertId) return null
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const row = await db.certStore.findOne(
    and(eq(schema.certStore.id, connection.spCertId), eq(schema.certStore.status, 'active')),
  )
  return row ?? null
}

// 把 CertStore 行信封解密 -> 不可导出 RSA-OAEP 解密私钥(私钥明文清零,不出 isolate,见 signing-keys rule)。
async function importSpDecryptKey(cert: CertRow, kekB64: string): Promise<CryptoKey> {
  const pkcs8 = await envelopeDecrypt(
    {
      iv: new Uint8Array(cert.privateKeyIv),
      ciphertext: new Uint8Array(cert.privateKeyCiphertext),
      tag: new Uint8Array(cert.privateKeyTag),
      kekVersion: cert.kekVersion,
    },
    decodeKek(kekB64),
  )
  const key = await crypto.subtle.importKey(
    'pkcs8',
    toBufferSource(pkcs8),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  )
  pkcs8.fill(0)
  return key
}

// 解析 connection 的 SP 解密私钥(EncryptedAssertion 路径用)。无配置时返回 undefined(明文 Assertion 不需要)。
export async function loadSpDecryptKey(
  c: Context<XidHonoEnv>,
  connection: SamlConnection,
): Promise<CryptoKey | undefined> {
  const cert = await findSpDecryptCert(c, connection)
  if (!cert) return undefined
  return importSpDecryptKey(cert, c.env.KEK)
}

async function importSpSigningKey(cert: CertRow, kekB64: string): Promise<CryptoKey> {
  const pkcs8 = await envelopeDecrypt(
    {
      iv: new Uint8Array(cert.privateKeyIv),
      ciphertext: new Uint8Array(cert.privateKeyCiphertext),
      tag: new Uint8Array(cert.privateKeyTag),
      kekVersion: cert.kekVersion,
    },
    decodeKek(kekB64),
  )
  const key = await crypto.subtle.importKey(
    'pkcs8',
    toBufferSource(pkcs8),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  pkcs8.fill(0)
  return key
}

// 取首个 active SP 签名私钥(SLO LogoutResponse 签名用)。无配置返回 null。
export async function loadSpSigningKey(c: Context<XidHonoEnv>): Promise<CryptoKey | null> {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const row = await db.certStore.findOne(
    and(eq(schema.certStore.usage, 'saml_sp_signing'), eq(schema.certStore.status, 'active')),
  )
  if (!row) return null
  return importSpSigningKey(row, c.env.KEK)
}
