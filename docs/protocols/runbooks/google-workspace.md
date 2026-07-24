# Google Workspace inbound SAML runbook

## Console steps

1. Open **Console → Organization → Inbound enterprise SSO**.
2. Click **Add Google Workspace template** to pre-fill metadata URL, attribute mapping, and JIT defaults.
3. Replace placeholder tokens in the IdP metadata URL and paste the IdP signing certificate into **IdP certificates**.
4. Paste the upstream IdP signing certificate into **IdP certificates** (inbound) or configure SP ACS URL and entity ID (outbound).
5. Download XID metadata from the console copy paths and upload to the upstream IdP or downstream SaaS admin UI.

## Local L3 evidence

- Smoke harness: `apps/server/tests/smoke/l3-inbound-saml.test.mjs`
- Preset source: `apps/server/worker/sso/provider-presets.ts`
- Console: `apps/server/src/routes/org/OrgSso.tsx`

## Production L4 blocked inputs

- Real admin access, live metadata, signed callback round-trip, and provider-specific assignment gates are still required before production-supported claims.

## L4 production evidence

- Provider: `Google Workspace`; direction: `inbound`.
- Current HEAD: run `git rev-parse HEAD` and record the complete commit.
- Active Worker version: run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the `version_id` at 100 percent.
- Smoke: run `pnpm --filter @xid-kit/server smoke:l3:inbound-saml`, then complete one signed IdP initiated or SP initiated SAML callback in the production test tenant.
- Transaction evidence: record UTC timestamp, de-identified tenant_id, de-identified connection_id, provider transaction id or assertion/request id, expected result, and actual result.
- Cleanup: remove the test SSO connection, IdP app assignment, and test user access, then confirm the callback no longer authorizes.
- BLOCKED evidence: record missing Google Workspace admin access, isolated test tenant, callback domain, test user, assignment, or signing material. Do not record secrets, complete assertions, or personal data.
