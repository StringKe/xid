# PingFederate inbound SAML runbook

## Console steps

1. Open **Console -> Organization -> Enterprise SSO** and choose **Add connection**.
2. Pick **PingFederate** and **SAML 2.0**. The preset sets the attribute mapping (`email`, `givenName`, `surname`) and JIT, and requires a signed Assertion.
3. Enter the PingFederate metadata URL, in the form `https://<pingfederate-host>/pf/federation_metadata.ping`. XID fetches and parses it when the connection is saved and fills Entity ID, sign-in URL, and signing certificates. A fetch or parse failure returns 422 on `idp_metadata_url`, and a value that still contains `{` or `}` is rejected.
4. Copy the **ACS URL** and **Entity ID** shown in the wizard into the PingFederate SP connection, or give PingFederate the SP metadata from `/sso/saml/{connectionId}/metadata`.

## Local L3 evidence

- Smoke harness: `apps/server/tests/smoke/l3-inbound-saml.test.mjs`
- Preset source: `apps/server/worker/sso/provider-presets.ts`
- Console: `apps/console/src/routes/org/OrgSso.tsx`

## Production L4 blocked inputs

- Real admin access, live metadata, signed callback round-trip, and provider-specific assignment gates are still required before production-supported claims.

## L4 production evidence

- Provider: `PingFederate`; direction: `inbound`.
- Current HEAD: run `git rev-parse HEAD` and record the complete commit.
- Active Worker version: run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the `version_id` at 100 percent.
- Smoke: run `pnpm --filter @xid-kit/server smoke:l3:inbound-saml`, then complete one signed IdP initiated or SP initiated SAML callback in the production test tenant.
- Transaction evidence: record UTC timestamp, de-identified tenant_id, de-identified connection_id, provider transaction id or assertion/request id, expected result, and actual result.
- Cleanup: remove the test SSO connection, IdP app assignment, and test user access, then confirm the callback no longer authorizes.
- BLOCKED evidence: record missing PingFederate admin access, isolated test tenant, callback domain, test user, assignment, or signing material. Do not record secrets, complete assertions, or personal data.
