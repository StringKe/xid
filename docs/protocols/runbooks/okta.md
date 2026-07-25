# Okta inbound SAML runbook

## Console steps

1. Open **Console -> Organization -> Inbound enterprise SSO**.
2. Click **Add Okta template** to pre-fill metadata URL, attribute mapping, and JIT defaults.
3. Replace `{oktaDomain}` and `{appId}` placeholders with your Okta org domain and SAML app id.
4. Paste the Okta IdP signing certificate from metadata into **IdP certificates**.
5. Download XID SP metadata from `/sso/saml/{connectionId}/metadata` and upload to the Okta SAML app.
6. Set ACS URL to `https://{tenant}/sso/saml/{connectionId}/acs`.

## Local L3 evidence

- Fake IdP harness: `apps/server/tests/smoke/l3-inbound-saml.test.mjs`
- Preset source: `apps/server/worker/sso/provider-presets.ts`

## Production L4 blocked inputs

- Real Okta admin access, live metadata URL, signed SAMLResponse callback, and SCIM provisioning app (separate from OIDC login).

## L4 production evidence

- Provider: `Okta`; direction: `inbound`.
- Current HEAD: run `git rev-parse HEAD` and record the complete commit.
- Active Worker version: run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the `version_id` at 100 percent.
- Smoke: run `pnpm --filter @xid-kit/server smoke:l3:inbound-saml`, then complete one signed Okta SAML callback in the production test tenant.
- Transaction evidence: record UTC timestamp, de-identified tenant_id, de-identified connection_id, provider transaction id or assertion/request id, expected result, and actual result.
- Cleanup: remove the test SSO connection, Okta app assignment, and test user access, then confirm the callback no longer authorizes.
- BLOCKED evidence: record missing Okta admin access, isolated test tenant, callback domain, test user, assignment, or signing material. Do not record secrets, complete assertions, or personal data.
