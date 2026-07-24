import type { Hono } from 'hono'
import { resolveInstanceLoginCandidates, resolveTenantContextById } from '@xid-kit/db'
import type { XidHonoEnv } from '../lib/types'
import { ambiguousHostedAuthConfig, publicHostedAuthConfig } from './hosted-policy'
import { smsDeliveryReady, whatsappDeliveryReady } from './delivery-channels'
import { loginHintCandidates, resolveEntryTenant } from '../me-auth/instance-login'
import { hasProviderSecret } from './social-providers'

export function registerHostedAuthConfigRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/auth/config', async (c) => {
    const loginHint = c.req.query('login_hint')?.trim()
    const organizationId = c.req.query('organization_id')?.trim()
    if (organizationId && c.get('tenant').resolution?.unresolvedRoot) {
      const result = await resolveTenantContextById(c.req.raw, c.env, organizationId)
      if (result.ok) {
        return c.json(
          publicHostedAuthConfig(
            result.value.tenant,
            (policy) => hasProviderSecret(c.env, policy),
            (method) =>
              (method !== 'whatsappOtp' || whatsappDeliveryReady(result.value.tenant, c.env)) &&
              (method !== 'smsOtp' || smsDeliveryReady(result.value.tenant, c.env)),
          ),
        )
      }
    }
    if (loginHint && c.get('tenant').resolution?.unresolvedRoot) {
      const result = await resolveInstanceLoginCandidates(
        c.req.raw,
        c.env,
        loginHintCandidates(loginHint),
      )
      if (result.ok && result.value.status === 'ambiguous') {
        return c.json(
          ambiguousHostedAuthConfig({
            matchedBy: result.value.matchedBy,
            matches: result.value.matches,
          }),
        )
      }
    }
    const tenant = loginHint
      ? await resolveEntryTenant(c, loginHintCandidates(loginHint))
      : c.get('tenant')
    return c.json(
      publicHostedAuthConfig(
        tenant,
        (policy) => hasProviderSecret(c.env, policy),
        (method) =>
          (method !== 'whatsappOtp' || whatsappDeliveryReady(tenant, c.env)) &&
          (method !== 'smsOtp' || smsDeliveryReady(tenant, c.env)),
      ),
    )
  })
}
