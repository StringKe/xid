# Slack downstream SAML runbook

## Console steps

1. Open **Console -> Organization -> SAML apps** and choose **Add SAML app**.
2. Pick **Slack** under **App**. The preset sets Entity ID `https://slack.com`, the attribute mapping (`email`, `User.Email`, `first_name`, `last_name`, `display_name`), the `emailAddress` NameID format, and no single logout URL, because Slack does not support Single Logout.
3. Set **Assertion consumer URL** to `https://<workspace>.slack.com/sso/saml`. A value that still contains `{` or `}` returns 422.
4. From **Give these to Slack** on the app page, copy the Sign-in URL and Issuer into the Slack SAML settings and paste the signing certificate from the downloaded IdP metadata.
5. Limit **Who can sign in** if needed, then confirm the ACS POST round-trip in staging.

## Local L3 evidence

- Smoke harness: `apps/server/tests/smoke/l3-protocol-client.test.mjs`
- Preset source: `apps/server/worker/sso/provider-presets.ts`
- Console: `apps/console/src/routes/org/OrgOutboundSso.tsx`

## Production L4 blocked inputs

- Real admin access, live metadata, signed callback round-trip, and provider-specific assignment gates are still required before production-supported claims.

## L4 production evidence

- Provider: `Slack`; direction: `outbound`.
- Current HEAD: run `git rev-parse HEAD` and record the complete commit.
- Active Worker version: run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the `version_id` at 100 percent.
- Smoke: run `pnpm --filter @xid-kit/server smoke:l3:protocol-client`, then complete one downstream SaaS SAML or OIDC login from the production test tenant.
- Transaction evidence: record UTC timestamp, de-identified tenant_id, de-identified connection_id, provider transaction id or assertion/request id, expected result, and actual result.
- Cleanup: remove the downstream app assignment, test connection, and test user access, then confirm the downstream login is denied.
- BLOCKED evidence: record missing Slack admin access, isolated test tenant, callback domain, test user, assignment, or signing material. Do not record secrets, complete assertions, or personal data.
