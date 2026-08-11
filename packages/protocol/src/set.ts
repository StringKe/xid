import type { SigningAlg, TenantContext } from '@xid-kit/types'
import { signJwt } from '@xid-kit/crypto'

export type SetDelivery = {
  streamId: string
  endpoint: string
}

export type SetEventInput = {
  ctx: TenantContext
  signingKey: CryptoKey
  eventType: string
  subject: Record<string, unknown>
  audience: string
  now?: number
  ttlSec?: number
}

function activeAlg(ctx: TenantContext): SigningAlg {
  const kid = ctx.signingKeys.activeKid
  const material = ctx.signingKeys.keys.find((k) => k.kid === kid)
  return material?.alg ?? ctx.signingKeys.defaultAlg
}

function activeKid(ctx: TenantContext): string {
  return ctx.signingKeys.activeKid
}

export async function signSet(input: SetEventInput): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const ttlSec = input.ttlSec ?? 300
  const alg = activeAlg(input.ctx)
  const kid = activeKid(input.ctx)
  return signJwt(
    {
      header: { alg, kid, typ: 'secevent+jwt' },
      payload: {
        iss: input.ctx.issuer,
        aud: input.audience,
        iat: now,
        exp: now + ttlSec,
        jti: crypto.randomUUID(),
        events: { [input.eventType]: input.subject },
      },
    },
    input.signingKey,
  )
}

export const CAEP_SESSION_REVOKED =
  'https://schemas.openid.net/secevent/caep/event-type/session-revoked'
export const RISC_ACCOUNT_CREDENTIAL_CHANGE =
  'https://schemas.openid.net/secevent/risc/event-type/account-credential-change'
