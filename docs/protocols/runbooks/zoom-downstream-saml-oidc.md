# Zoom downstream SAML/OIDC runbook

## Console steps

1. Open **Console -> Organization -> Outbound enterprise SSO**.
2. Click **Add Zoom template** to pre-fill SP entity ID, ACS URL, and attribute mapping.
3. Replace placeholder tokens in SP entity ID and ACS URL fields.
4. Copy XID outbound metadata and SSO paths from the app row into the downstream SaaS admin UI.
5. For SAML/OIDC presets, configure the OIDC redirect URI placeholder shown in the console in the downstream SaaS OIDC app registration.

## Local L3 evidence

- Smoke harness: `apps/server/tests/smoke/l3-protocol-client.test.mjs`
- Preset source: `apps/server/worker/sso/provider-presets.ts`
- Console: `apps/console/src/routes/org/OrgOutboundSso.tsx`

## Production L4 blocked inputs

- Real admin access, live metadata, signed callback round-trip, and provider-specific assignment gates are still required before production-supported claims.

## L4 production evidence

- Provider: `Zoom`; direction: `outbound`.
- Current HEAD: run `git rev-parse HEAD` and record the complete commit.
- Active Worker version: run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the `version_id` at 100 percent.
- Smoke: run `pnpm --filter @xid-kit/server smoke:l3:protocol-client`, then complete one downstream SaaS SAML or OIDC login from the production test tenant.
- Transaction evidence: record UTC timestamp, de-identified tenant_id, de-identified connection_id, provider transaction id or assertion/request id, expected result, and actual result.
- Cleanup: remove the downstream app assignment, test connection, and test user access, then confirm the downstream login is denied.
- BLOCKED evidence: record missing Zoom admin access, isolated test tenant, callback domain, test user, assignment, or signing material. Do not record secrets, complete assertions, or personal data.
